import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBED_DIMS } from "../src/config";
import type { Env } from "../src/env";
import { downloadUrl, handleExport, startExport } from "../src/export";
import { sign } from "../src/media";
import { createZipImport, handleZipCallback } from "../src/zip";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const started: Record<string, string>[] = [];
  const EXPORT = { idFromName: (n: string) => n, get: () => ({ run: async (_: string, vars: Record<string, string>) => void started.push(vars) }) };
  const upserts: VectorizeVector[] = [];
  const VECTORS = {
    getByIds: async (ids: string[]) => ids.filter((id) => id.endsWith(":t")).map((id) => ({ id, values: new Float32Array([0.5, 1]), metadata: { kind: "photo" } })),
    upsert: async (v: VectorizeVector[]) => void upserts.push(...v),
  };
  const jobs: any[] = [];
  const JOBS = { send: async (b: unknown) => void jobs.push(b), sendBatch: async (m: { body: unknown }[]) => void jobs.push(...m.map((x) => x.body)) };
  const telegram: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    telegram.push(String(input).split("/").pop()!);
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  const e = { ...env, PUBLIC_URL: "https://m.example", EXPORT, VECTORS, JOBS } as unknown as Env;
  return { e, started, upserts, jobs, telegram };
}

const call = async (e: Env, id: string, path: string, init: RequestInit = {}, token?: string) =>
  handleExport(
    new Request(`https://m.example/export/${id}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token ?? (await sign(e, `export|${id}`))}` },
    }),
    e,
  );

describe("data export", () => {
  it("allows one export per day, but retries after a failure", async () => {
    const { e, started } = setup();
    const first = await startExport(e, 41);
    expect(first).toHaveProperty("id");
    expect(started[0]).toMatchObject({ MODE: "export", API_URL: `https://m.example/export/${(first as { id: string }).id}` });
    expect(await startExport(e, 41)).toHaveProperty("next_at");
    await e.DB.prepare("UPDATE exports SET status = 'failed' WHERE user_id = 41").run();
    expect(await startExport(e, 41)).toHaveProperty("id");
  });

  it("serves only the user's whitelisted data and uploads the archive", async () => {
    const { e, telegram } = setup();
    await e.DB.prepare("INSERT INTO users (id, username, role, openrouter_key, sub_charge_id) VALUES (42, 'me', 'user', 'SECRET', 'CHARGE')").run();
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, r2_file, title, status) VALUES ('a', 42, 'photo', 'FILEID', 'u1', 'k/a.jpg', 'Cat', 'ready'), ('b', 43, 'photo', 'f', 'u2', 'k/b.jpg', 'Other', 'ready')",
    ).run();
    await e.MEDIA.put("k/a.jpg", "A", { httpMetadata: { contentType: "image/jpeg" } });
    const { id } = (await startExport(e, 42)) as { id: string };

    expect((await call(e, id, "table/profile", {}, "bad")).status).toBe(403);
    expect((await call(e, id, "table/oauth_states")).status).toBe(400);
    const profile = await (await call(e, id, "table/profile")).json<any>();
    expect(profile.columns).not.toContain("openrouter_key");
    expect(profile.columns).not.toContain("sub_charge_id");
    expect(JSON.stringify(profile)).not.toMatch(/SECRET|CHARGE/);
    const memes = await (await call(e, id, "table/memes")).json<any>();
    expect(memes.columns).not.toContain("file_id");
    expect(memes.rows).toHaveLength(1);
    expect(memes.rows[0][memes.columns.indexOf("has_file")]).toBe(1);
    expect(memes.next).toBeNull();

    expect(await (await call(e, id, "vectors?ids=a,b")).json()).toEqual([{ id: "a:t", values: [0.5, 1], metadata: { kind: "photo" } }]);
    expect(await (await call(e, id, "media/a/file")).text()).toBe("A");
    expect((await call(e, id, "media/b/file")).status).toBe(404);
    expect((await call(e, id, "media/a/preview")).status).toBe(404); // no own preview

    expect((await call(e, id, "start", { method: "POST", body: "{}" })).status).toBe(200);
    const part = await (await call(e, id, "part?n=1", { method: "PUT", body: "ZIPDATA" })).json();
    expect((await call(e, id, "complete", { method: "POST", body: JSON.stringify({ parts: [part] }) })).status).toBe(200);
    expect((await call(e, id, "done", { method: "POST", body: JSON.stringify({ size: 7, files: 1, failed: 0 }) })).status).toBe(200);
    expect(await e.DB.prepare("SELECT status, size, files FROM exports WHERE id = ?").bind(id).first()).toEqual({ status: "done", size: 7, files: 1 });
    expect(telegram).toContain("sendMessage");

    const url = await downloadUrl(e, id);
    const res = await handleExport(new Request(url), e);
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment/);
    expect(await res.text()).toBe("ZIPDATA");
    expect((await handleExport(new Request(url.replace(/s=.*/, "s=bad")), e)).status).toBe(404);
    expect((await call(e, id, "table/profile")).status).toBe(403); // finished
  });

  it("restores exported memes on zip import without AI processing", async () => {
    const { e, upserts, jobs } = setup();
    const zip = await createZipImport(e, 44, "en");
    await e.DB.prepare("UPDATE zip_imports SET status = 'running' WHERE id = ?").bind(zip.id).run();
    const vec = Array(EMBED_DIMS).fill(0.1);
    const items = [
      { sha256: "a".repeat(64), kind: "photo", mime: "image/jpeg", restore: { title: "Cat", tags: "cat\nfunny", created_at: 1700000000, image: vec, text: vec } },
      { sha256: "b".repeat(64), kind: "photo", mime: "image/jpeg", restore: { title: "Bad", text: [1] } }, // incomplete: processed again
    ];
    const res = await handleZipCallback(
      new Request(`https://m.example/zip/${zip.id}/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await sign(e, `zip|${zip.id}`)}` },
        body: JSON.stringify({ items }),
      }),
      e,
    );
    expect(res.status).toBe(200);
    const rows = await e.DB.prepare("SELECT sha256, status, title, tags, created_at, import_id IS NULL AS no_batch FROM memes WHERE user_id = 44 ORDER BY sha256").all();
    expect(rows.results).toEqual([
      { sha256: "a".repeat(64), status: "ready", title: "Cat", tags: "cat\nfunny", created_at: 1700000000, no_batch: 1 },
      { sha256: "b".repeat(64), status: "embedding", title: null, tags: null, created_at: expect.any(Number), no_batch: 1 },
    ]);
    expect(upserts.map((v) => v.id.split(":")[1]).sort()).toEqual(["i", "t"]);
    expect(jobs).toHaveLength(1);
    expect(await e.DB.prepare("SELECT imported FROM zip_imports WHERE id = ?").bind(zip.id).first("imported")).toBe(2);
  });
});
