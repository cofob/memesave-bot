import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { sign } from "../src/media";
import { createZipImport, handleUpload, handleZipCallback } from "../src/zip";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const jobs: any[] = [];
  const JOBS = {
    send: async (b: unknown) => void jobs.push(b),
    sendBatch: async (m: { body: unknown }[]) => void jobs.push(...m.map((x) => x.body)),
  } as unknown as Queue;
  const telegram: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    telegram.push(String(input).split("/").pop()!);
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  return { e: { ...env, PUBLIC_URL: "https://m.example", JOBS } as Env, jobs, telegram };
}

const call = async (e: Env, id: string, action: string, body: unknown, token?: string) =>
  handleZipCallback(
    new Request(`https://m.example/zip/${id}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token ?? (await sign(e, `zip|${id}`))}` },
      body: JSON.stringify(body),
    }),
    e,
  );

// Shaped like the Go container's JSON: empty fields are left out.
const item = (sha256: string, kind: string, thumb = false) => ({ sha256, kind, thumb, mime: "image/jpeg", caption: "hi" });
const sha = (c: string) => c.repeat(64);

describe("zip import", () => {
  it("creates a signed upload link and rejects bad signatures", async () => {
    const { e } = setup();
    const zip = await createZipImport(e, 31, "en");
    expect(zip.button.url).toMatch(new RegExp(`^https://m\\.example/upload/${zip.id}\\?e=\\d+&s=`));
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
    expect((await handleUpload(new Request(zip.button.url), e, ctx)).status).toBe(200);
    expect((await handleUpload(new Request(zip.button.url.replace(/s=.*/, "s=bad")), e, ctx)).status).toBe(403);
  });

  it("allows one running import per user", async () => {
    const { e } = setup();
    const [a, b] = [await createZipImport(e, 33, "en"), await createZipImport(e, 33, "en")];
    await e.DB.prepare("UPDATE zip_imports SET status = 'running' WHERE id = ?").bind(a.id).run();
    await e.DB.prepare("UPDATE zip_imports SET upload_id = 'x' WHERE id = ?").bind(b.id).run();
    const complete = new Request(b.button.url.replace("?", "/complete?"), { method: "POST", body: "{}" });
    const res = await handleUpload(complete, e, { waitUntil: () => {} } as unknown as ExecutionContext);
    expect(res.status).toBe(409);
  });

  it("dedupes by sha256, routes photos to the batch and finishes", async () => {
    const { e, jobs, telegram } = setup();
    const zip = await createZipImport(e, 32, "en");
    await e.DB.prepare("UPDATE zip_imports SET status = 'running', status_msg_id = 9 WHERE id = ?").bind(zip.id).run();
    await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, sha256) VALUES ('old', 32, 'photo', 'f', 'u', ?)").bind(sha("a")).run();

    expect((await call(e, zip.id, "filter", { hashes: [sha("a")] }, "bad")).status).toBe(403);
    const filter = await call(e, zip.id, "filter", { hashes: [sha("a"), sha("b"), sha("c")], found: 4, formats: ["telegram_html", "files"] });
    expect(await filter.json()).toEqual({ new: [sha("b"), sha("c")] });

    const blob = await handleZipCallback(
      new Request(`https://m.example/zip/${zip.id}/blob/${sha("c")}?thumb=1`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${await sign(e, `zip|${zip.id}`)}`, "Content-Type": "image/jpeg" },
        body: "THUMB",
      }),
      e,
    );
    expect(blob.status).toBe(200);
    expect(await (await e.MEDIA.get(`u/32/${sha("c")}.preview.jpg`))!.text()).toBe("THUMB");

    expect((await call(e, zip.id, "items", { items: [item(sha("b"), "photo"), item(sha("c"), "video", true)] })).status).toBe(200);
    const rows = await e.DB.prepare(
      "SELECT kind, file_id, file_unique_id, r2_file, r2_preview, duration, import_id IS NOT NULL AS in_batch, caption FROM memes WHERE user_id = 32 AND id != 'old' ORDER BY sha256",
    ).all();
    expect(rows.results).toEqual([
      { kind: "photo", file_id: "", file_unique_id: `r2:${sha("b")}`, r2_file: `u/32/${sha("b")}.jpg`, r2_preview: null, duration: null, in_batch: 1, caption: "hi" },
      {
        kind: "video",
        file_id: "",
        file_unique_id: `r2:${sha("c")}`,
        r2_file: `u/32/${sha("c")}.jpg`,
        r2_preview: `u/32/${sha("c")}.preview.jpg`,
        duration: null,
        in_batch: 0,
        caption: "hi",
      },
    ]);
    expect(jobs).toHaveLength(2);
    expect(await e.DB.prepare("SELECT 1 FROM imports WHERE user_id = 32").first()).toBeNull(); // no manual batch mode

    await call(e, zip.id, "done", { failed: 0 });
    // The archive's photos are submitted as their own batch, without /batch_finish.
    const importId = await e.DB.prepare("SELECT import_id FROM memes WHERE file_unique_id = ?").bind(`r2:${sha("b")}`).first<string>("import_id");
    expect(await e.DB.prepare("SELECT status, status_msg_id FROM imports WHERE id = ?").bind(importId).first()).toEqual({ status: "submitting", status_msg_id: 9 });
    expect(jobs.at(-1)).toEqual({ type: "batch_submit", importId });
    const row = await e.DB.prepare("SELECT status, imported, skipped, total, format FROM zip_imports WHERE id = ?").bind(zip.id).first();
    expect(row).toEqual({ status: "done", imported: 2, skipped: 2, total: 2, format: "telegram_html,files" });
    expect(telegram).toEqual(["editMessageText", "sendMessage"]); // the second progress edit is throttled
    expect((await call(e, zip.id, "items", { items: [] })).status).toBe(403);
  });
});
