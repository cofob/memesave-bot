import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { describeStage, failIngest, finishStage, saveDescription, toDescription } from "../src/ingest/describe";
import { parseEdit } from "../src/ingest/edit";
import { createToken } from "../src/tokens";
import { handleApp } from "../src/webapp";

afterEach(() => vi.restoreAllMocks());

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const upserts: string[] = [];
const VECTORS = { upsert: async (v: { id: string }[]) => (upserts.push(...v.map((x) => x.id)), { mutationId: "m" }) };
const jobs: unknown[] = [];
const JOBS = { send: async (b: unknown) => void jobs.push(b) };
const e = { ...env, PUBLIC_URL: "https://m.example", VECTORS, JOBS } as unknown as Env;

describe("meme edits", () => {
  it("checks the fields", () => {
    expect(parseEdit({ tags: [" Cat ", ""], porn: true, saved_at: null })).toEqual({ tags: ["cat"], porn: true, saved_at: null });
    expect(parseEdit({})).toMatch(/no fields/);
    expect(parseEdit({ kind: "video" })).toMatch(/unknown field/);
    expect(parseEdit({ title: "" })).toMatch(/title/);
    expect(parseEdit({ tags: "cat" })).toMatch(/array/);
    expect(parseEdit({ porn: "yes" })).toMatch(/boolean/);
  });

  it("edits a ready meme through the API, embeds a new text and keeps the rest", async () => {
    await e.DB.batch([
      e.DB.prepare("INSERT INTO users (id, role) VALUES (71, 'admin')"),
      e.DB.prepare(
        `INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, tags, description) VALUES
         ('ed1', 71, 'photo', 'f', 'u-ed1', 'ready', 'old title', 'a', 'kept'), ('ed2', 71, 'photo', 'f', 'u-ed2', 'describing', NULL, NULL, NULL)`,
      ),
    ]);
    const write = (await createToken(e.DB, 71, "w", true))!.token;
    const read = (await createToken(e.DB, 71, "r", false))!.token;
    const patch = (token: string, id: string, body: unknown) =>
      handleApp(new Request(`https://m.example/app/api/memes/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { Authorization: `Bearer ${token}` } }), e, ctx);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { cost: 0 } }));

    const res = (await patch(write, "ed1", { title: "zebra dance", tags: ["Zebra", "dance"], saved_at: 1700000000 }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "zebra dance", tags: ["zebra", "dance"], description: "kept", saved_at: 1700000000 });
    expect(upserts).toEqual(["ed1:t"]);
    expect(await e.DB.prepare("SELECT rowid FROM memes_fts WHERE memes_fts MATCH 'zebra'").first()).toBeTruthy();

    expect((await patch(write, "ed1", { caption: "only caption" }))!.status).toBe(200);
    expect(upserts).toEqual(["ed1:t"]); // not a search text: no new embedding
    expect((await patch(write, "ed1", { kind: "video" }))!.status).toBe(400);
    expect((await patch(read, "ed1", { title: "x" }))!.status).toBe(403);
  });

  it("restarts an unfinished meme: old jobs do nothing, the AI keeps the edited fields", async () => {
    await e.DB.batch([
      e.DB.prepare("INSERT INTO users (id, role) VALUES (72, 'admin')"),
      e.DB.prepare(
        `INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, error) VALUES
         ('ep1', 72, 'photo', 'f', 'u-ep1', 'describing', NULL, NULL), ('ep2', 72, 'photo', 'f', 'u-ep2', 'failed', 'ai', 'boom')`,
      ),
    ]);
    const write = (await createToken(e.DB, 72, "w", true))!.token;
    const patch = (id: string, body: unknown) =>
      handleApp(new Request(`https://m.example/app/api/memes/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { Authorization: `Bearer ${write}` } }), e, ctx);
    const row = (id: string) => e.DB.prepare("SELECT status, gen, title, tags, caption, description, error FROM memes WHERE id = ?").bind(id).first();
    jobs.length = 0;

    const res = (await patch("ep1", { title: "mine", tags: ["Cat"], caption: "new caption" }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "mine", tags: ["cat"], caption: "new caption" });
    expect(await row("ep1")).toMatchObject({ status: "embedding", gen: 1, title: null, caption: "new caption" });
    expect(jobs).toEqual([{ type: "embed", memeId: "ep1", gen: 1 }]);

    const d = toDescription({ title: "ai title", description: "ai text", tags: ["dog"] }, "");
    // A describe request of the old run ends after the edit, and its stage tries to finish or fail.
    await e.DB.prepare("UPDATE memes SET status = 'describing' WHERE id = 'ep1'").run();
    expect((await saveDescription(e.DB, { id: "ep1", gen: 0 }, d).run()).meta.changes).toBe(0);
    await finishStage(e, "ep1", 0);
    await failIngest(e, "ep1", "old", 0);
    expect(await row("ep1")).toMatchObject({ status: "describing", title: null });

    // The new run: the AI fills only the fields the user did not edit.
    await saveDescription(e.DB, { id: "ep1", gen: 1 }, d).run();
    expect(await row("ep1")).toMatchObject({ title: "mine", tags: "cat", description: "ai text" });

    // All description fields edited: the describe stage makes no AI call.
    const full = { title: "t", ocr_text: "", speech_text: "", language: "en", description: "d", meme_context: "", cultural_meaning: "", tags: ["x"], search_phrases: [], porn: false };
    expect((await patch("ep1", full))!.status).toBe(200);
    await e.DB.prepare("UPDATE memes SET status = 'describing' WHERE id = 'ep1'").run();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { cost: 0 } }));
    await describeStage(e, "ep1", 0, false, 2);
    expect(fetch.mock.calls.every(([u]) => String(u).includes("embeddings"))).toBe(true);
    expect(await row("ep1")).toMatchObject({ status: "ready", title: "t", tags: "x", description: "d" });

    expect((await patch("ep2", { description: "fixed" }))!.status).toBe(200);
    expect(await row("ep2")).toMatchObject({ status: "embedding", gen: 1, title: null, error: null });
  });
});
