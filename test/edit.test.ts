import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { parseEdit } from "../src/ingest/edit";
import { createToken } from "../src/tokens";
import { handleApp } from "../src/webapp";

afterEach(() => vi.restoreAllMocks());

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const upserts: string[] = [];
const VECTORS = { upsert: async (v: { id: string }[]) => (upserts.push(...v.map((x) => x.id)), { mutationId: "m" }) };
const e = { ...env, PUBLIC_URL: "https://m.example", VECTORS } as unknown as Env;

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
    expect((await patch(write, "ed2", { title: "x" }))!.status).toBe(409);
    expect((await patch(write, "ed1", { kind: "video" }))!.status).toBe(400);
    expect((await patch(read, "ed1", { title: "x" }))!.status).toBe(403);
  });
});
