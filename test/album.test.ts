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

  // A comic of n pages (c1..cn, ids `<uid>c<i>`) of user `uid`; its last import was `age` seconds ago.
  const seed = async (uid: number, n: number, age: number) => {
    await c.DB.prepare("INSERT INTO users (id, role, lang) VALUES (?, 'user', 'en')").bind(uid).run();
    for (let i = 1; i <= n; i++) {
      await env.MEDIA.put(`u/${uid}/c${i}.jpg`, "IMG", { httpMetadata: { contentType: "image/jpeg" } });
      await c.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, r2_file, status) VALUES (?, ?, 'photo', 'f', ?, ?, 'describing')")
        .bind(`${uid}c${i}`, uid, `${uid}c${i}`, `u/${uid}/c${i}.jpg`)
        .run();
      await addToPost(c.DB, uid, { memeId: `${uid}c${i}`, mediaGroupId: `comic${uid}`, position: i, layout: "comic" });
    }
    await c.DB.prepare("UPDATE posts SET updated_at = updated_at - ? WHERE media_group_id = ?").bind(age, `comic${uid}`).run();
  };
  // Model answer: one item per image, titled "P<number in the order of all requests>"; `pornTitle` is porn.
  const mockModel = (sent: string[][], pornTitle = "") => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/embeddings")) return Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { cost: 0 } });
      const content = JSON.parse(String(init!.body)).messages[1].content;
      const items = content.filter((p: { type: string }) => p.type === "image_url").map(() => ({ title: `P${++n}`, porn: `P${n}` === pornTitle }));
      sent.push([content.find((p: { text?: string }) => p.text?.startsWith("This is an album"))?.text ?? "", ...items.map((i: { title: string }) => i.title)]);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { cost: 0 } });
    });
  };

  it("describes a comic in groups of 10 pages, each page gets its own description", async () => {
    await seed(83, 25, 60);
    const sent: string[][] = [];
    mockModel(sent);
    await describeStage(c, "83c12"); // not the first pending page of its group
    expect(sent).toEqual([]);
    await describeStage(c, "83c1");
    await describeStage(c, "83c11");
    await describeStage(c, "83c21");
    expect(sent.map((s) => s.length - 1)).toEqual([10, 10, 5]);
    expect(sent[1][0]).toContain("pages 11-20 of a comic of 25 pages");
    expect(sent[2][0]).toContain("pages 21-25 of a comic of 25 pages");
    expect(await row("83c1")).toEqual({ status: "ready", title: "P1" });
    expect(await row("83c12")).toEqual({ status: "describing", title: "P12" });
    expect(await row("83c25")).toEqual({ status: "describing", title: "P25" });
  });

  it("waits COMIC_WAIT seconds after the last import before describing a comic", async () => {
    await seed(85, 3, 30);
    jobs.length = 0;
    await describeStage(c, "85c1");
    expect(jobs).toEqual([{ type: "describe", memeId: "85c1", gen: 0, from: 0 }]);
    expect(await row("85c1")).toEqual({ status: "describing", title: null });
  });

  it("one porn page makes all pages of the comic porn", async () => {
    await seed(86, 25, 60);
    mockModel([], "P7");
    for (const i of [1, 11, 21]) await describeStage(c, `86c${i}`);
    for (let i = 2; i <= 25; i++) await finishStage(c, `86c${i}`);
    const { results } = await c.DB.prepare("SELECT id, porn FROM memes WHERE user_id = 86").all<{ porn: number }>();
    expect(results).toHaveLength(25);
    expect(results.every((r) => r.porn === 1)).toBe(true);
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

  it("deletes a whole album or comic through the API, 100 memes per call", async () => {
    const calls: number[] = [];
    const d = { ...c, VECTORS: { deleteByIds: async (ids: string[]) => void calls.push(ids.length / 2) } } as unknown as Env;
    await seed(87, 3, 0);
    await seed(88, 120, 0);
    await c.DB.prepare("INSERT INTO users (id, role) VALUES (89, 'user')").run();
    await c.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES ('solo', 89, 'photo', 'f', 'solo', 'ready')").run();
    const del = async (uid: number, id: string) =>
      handleApp(new Request(`https://m.example/app/api/memes/${id}/delete_album`, { method: "POST", headers: { Authorization: `Bearer ${(await createToken(c.DB, uid, "w", true))!.token}` } }), d, ctx);
    const count = async (uid: number) => (await c.DB.prepare("SELECT COUNT(*) AS n FROM memes WHERE user_id = ?").bind(uid).first<{ n: number }>())!.n;

    expect((await del(89, "87c2"))!.status).toBe(404); // not the owner
    expect(await count(87)).toBe(3);
    const res = (await del(87, "87c2"))!;
    expect(((await res.json()) as { deleted: string[] }).deleted).toEqual(["87c1", "87c2", "87c3"]);
    expect(await count(87)).toBe(0);
    expect(await c.DB.prepare("SELECT 1 FROM posts WHERE user_id = 87").first()).toBeNull();

    const big = ((await (await del(88, "88c60"))!.json()) as { deleted: string[] }).deleted;
    expect(big).toHaveLength(120);
    expect(calls).toEqual([3, 100, 20]);
    expect(await count(88)).toBe(0);
    expect(await env.MEDIA.get("u/88/c120.jpg")).toBeNull();

    expect(((await (await del(89, "solo"))!.json()) as { deleted: string[] }).deleted).toEqual(["solo"]); // not in an album
    expect(await count(89)).toBe(0);
  });
});
