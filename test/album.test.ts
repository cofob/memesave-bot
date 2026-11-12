import { env } from "cloudflare:test";
import type { Message } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../src/bot";
import type { Env } from "../src/env";
import { addToPost } from "../src/channels";
import { getMeme, getUser } from "../src/db";
import { describeStage, editStatus, finishStage } from "../src/ingest/describe";
import { receiveMedia } from "../src/ingest/receive";
import { createToken } from "../src/tokens";
import { detail, handleApp, listMemes } from "../src/webapp";

afterEach(() => vi.restoreAllMocks());

const e = { ...env, JOBS: { send: async () => {} } } as unknown as Env;
const photo = (n: number) =>
  ({ message_id: n, media_group_id: "g1", photo: [{ file_id: `f${n}`, file_unique_id: `u${n}`, width: 1, height: 1 }] }) as unknown as Message;

describe("album status message", () => {
  it("sends one status message for a media group and shows its progress", async () => {
    await e.DB.prepare("INSERT INTO users (id, role, lang) VALUES (81, 'user', 'en')").run();
    const sendWidget = vi.fn(async () => ({ message_id: 50 }));
    const ctx = { user: { id: 81 }, lang: "en", api: { raw: { sendWidget } }, react: async () => {} } as unknown as Ctx;
    await Promise.all([1, 2, 3].map((n) => receiveMedia(ctx, e, photo(n))));
    expect(sendWidget).toHaveBeenCalledTimes(1);
    const { results } = await e.DB.prepare("SELECT id, status_msg_id FROM memes WHERE user_id = 81").all<{ id: string; status_msg_id: number }>();
    expect(results.map((r) => r.status_msg_id)).toEqual([50, 50, 50]);

    const edits: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      edits.push(`${String(url).split("/").pop()} ${body.chat_data ?? body.caption}`);
      return Response.json({ ok: true, result: true });
    });
    await e.DB.prepare("UPDATE memes SET status = 'ready', title = 'A' WHERE file_unique_id = 'u1'").run();
    await editStatus(e, (await getMeme(e.DB, results[0].id))!, "ignored");
    await e.DB.prepare("UPDATE memes SET status = 'ready', title = 'B' WHERE user_id = 81 AND title IS NULL").run();
    await editStatus(e, (await getMeme(e.DB, results[1].id))!, "ignored");
    // The widget's state on each step, the caption (what clients without widgets show) once all are done.
    expect(edits).toEqual([
      'editMessageWidgetData {"n":3,"d":1,"r":["A"],"s":"i"}',
      'editMessageWidgetData {"n":3,"d":3,"r":["A","B","B"],"s":"r"}',
      expect.stringMatching(/^editMessageCaption .*Saved 3 of 3:\n• <b>A<\/b>\n• <b>B<\/b>\n• <b>B<\/b>$/),
    ]);
  });
});

describe("albums in the app", () => {
  it("lists an album as its first meme and shows the album in the detail", async () => {
    const db = e.DB;
    await db.prepare("INSERT INTO users (id, role, lang) VALUES (82, 'user', 'en')").run();
    for (const id of ["a1", "a2", "s1"]) {
      await db.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES (?, 82, 'photo', 'f', ?, 'ready')").bind(id, id).run();
    }
    await addToPost(db, 82, { memeId: "a2", mediaGroupId: "g", position: 2 });
    await addToPost(db, 82, { memeId: "a1", mediaGroupId: "g", position: 1 });
    await addToPost(db, 82, { memeId: "s1" });
    const user = (await getUser(db, 82))!;

    const page = await listMemes(e, user, new URL("https://x/app/api/memes"));
    expect(page.items.map((m) => [m.id, m.album]).sort()).toEqual([["a1", 2], ["s1", undefined]]);
    const filtered = await listMemes(e, user, new URL("https://x/app/api/memes?kind=photo"));
    expect(filtered.items.map((m) => m.id).sort()).toEqual(["a1", "a2", "s1"]);
    expect((await detail(e, (await getMeme(db, "a2"))!)).album.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect((await detail(e, (await getMeme(db, "s1"))!)).album).toEqual([]);
  });
});

describe("comics", () => {
  const jobs: any[] = [];
  const VECTORS = { upsert: async () => ({ mutationId: "m" }) };
  const c = { ...env, VECTORS, PUBLIC_URL: "https://m.example", JOBS: { send: async (b: unknown) => void jobs.push(b) } } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const row = (id: string) => c.DB.prepare("SELECT status, title FROM memes WHERE id = ?").bind(id).first<{ status: string; title: string | null }>();

  it("describes the first 10 pages in one request, the later pages copy page 1", async () => {
    await c.DB.prepare("INSERT INTO users (id, role, lang) VALUES (83, 'user', 'en')").run();
    for (let i = 1; i <= 12; i++) {
      await env.MEDIA.put(`u/83/c${i}.jpg`, "IMG", { httpMetadata: { contentType: "image/jpeg" } });
      await c.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, r2_file, status) VALUES (?, 83, 'photo', 'f', ?, ?, 'describing')")
        .bind(`c${i}`, `c${i}`, `u/83/c${i}.jpg`)
        .run();
      await addToPost(c.DB, 83, { memeId: `c${i}`, mediaGroupId: "comic1", position: i, layout: "comic" });
    }
    await c.DB.prepare("UPDATE posts SET updated_at = updated_at - 60 WHERE media_group_id = 'comic1'").run();
    const sent: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/embeddings")) return Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { cost: 0 } });
      const content = JSON.parse(String(init!.body)).messages[1].content;
      sent.push(content.filter((p: { type: string }) => p.type === "image_url").length);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ items: content.filter((p: { type: string }) => p.type === "image_url").map((_: unknown, i: number) => ({ title: `Page ${i + 1}` })) }) } }], usage: { cost: 0 } });
    });

    await describeStage(c, "c12"); // page 1 has no description yet: it waits for the finish of page 1
    expect(await row("c12")).toEqual({ status: "describing", title: null });
    await describeStage(c, "c1");
    expect(sent).toEqual([10]);
    expect(await row("c1")).toEqual({ status: "ready", title: "Page 1" });
    expect(await row("c5")).toEqual({ status: "describing", title: "Page 5" });
    expect(await row("c11")).toEqual({ status: "describing", title: "Page 1" });
    expect(jobs.filter((j) => j.type === "finish").map((j) => j.memeId)).toEqual(["c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"]);
    await finishStage(c, "c11");
    await finishStage(c, "c12");
    expect(await row("c12")).toEqual({ status: "ready", title: "Page 1" });

    // A later page that comes after page 1 has its description copies it itself.
    await c.DB.prepare("UPDATE memes SET status = 'describing', title = NULL WHERE id = 'c11'").run();
    await describeStage(c, "c11");
    expect(await row("c11")).toEqual({ status: "ready", title: "Page 1" });
    expect(sent).toEqual([10]);
  });

  it("switches the layout of an own album through the API", async () => {
    await c.DB.prepare("INSERT INTO users (id, role) VALUES (84, 'user')").run();
    await c.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES ('l1', 84, 'photo', 'f', 'l1', 'ready'), ('l2', 84, 'photo', 'f', 'l2', 'ready')").run();
    await addToPost(c.DB, 84, { memeId: "l1", mediaGroupId: "lg", position: 1 });
    await addToPost(c.DB, 84, { memeId: "l2", mediaGroupId: "lg", position: 2 });
    const token = (await createToken(c.DB, 84, "w", true))!.token;
    const set = (layout: unknown) =>
      handleApp(new Request("https://m.example/app/api/memes/l2/layout", { method: "POST", body: JSON.stringify({ layout }), headers: { Authorization: `Bearer ${token}` } }), c, ctx);

    expect((await detail(c, (await getMeme(c.DB, "l1"))!)).layout).toBe("carousel");
    const res = (await set("comic"))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ layout: "comic" });
    expect((await detail(c, (await getMeme(c.DB, "l1"))!)).layout).toBe("comic");
    expect((await set("grid"))!.status).toBe(400);
  });
});
