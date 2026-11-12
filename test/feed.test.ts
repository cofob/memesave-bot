import { env } from "cloudflare:test";
import { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addToPost } from "../src/channels";
import { visible } from "../src/db";
import type { Env } from "../src/env";
import { feedPage, markSeen, type FeedMode } from "../src/feed";
import { showFeed } from "../src/feedbot";
import { handleApp } from "../src/webapp";

afterEach(() => vi.restoreAllMocks());

const e = { ...env, PUBLIC_URL: "https://m.example" } as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const enc = (s: string) => new TextEncoder().encode(s);
async function hmac(key: BufferSource, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc(data)));
}
/** Builds Mini App initData the way Telegram signs it. */
async function initData(botToken: string, user: object) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  params.set("hash", [...(await hmac(await hmac(enc("WebAppData"), botToken), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return params.toString();
}
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

/** Adds a meme of `user` created `ago` seconds back, optionally saved at the source `saved` seconds back. */
const add = (user: number, id: string, ago: number, saved: number | null = null, status = "ready") =>
  e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, created_at, saved_at) VALUES (?, ?, 'photo', 'f', ?, ?, ?, ?)")
    .bind(id, user, id, status, now - ago, saved === null ? null : now - saved)
    .run();
const use = (user: number, id: string) => e.DB.prepare("INSERT INTO meme_uses (user_id, meme_id, via) VALUES (?, ?, 'send')").bind(user, id).run();
const ids = async (user: number, mode: FeedMode, opts: { seed?: number; offset?: number; limit?: number; newer?: boolean } = {}) =>
  (await feedPage(e.DB, user, { mode, seed: 1, offset: 0, limit: 50, ...opts })).memes.map((m) => m.id);

describe("feed modes", () => {
  it("orders by saved_at or created_at, counts uses, skips failed and other users' memes", async () => {
    await add(91, "a", 3 * DAY);
    await add(91, "b", 1 * DAY, 10 * DAY); // a TikTok like from long ago
    await add(91, "c", 2 * DAY);
    await add(91, "x", 0, null, "failed");
    await add(92, "o", 0);
    await use(91, "c");
    await use(91, "c");
    await use(91, "a");

    expect(await ids(91, "new")).toEqual(["c", "a", "b"]);
    expect(await ids(91, "old")).toEqual(["b", "a", "c"]);
    expect(await ids(91, "favorites")).toEqual(["c", "a"]);
    expect(await ids(91, "forgotten")).toEqual(["b"]);
    const page = await feedPage(e.DB, 91, { mode: "new", seed: 1, offset: 1, limit: 1 });
    expect(page.memes.map((m) => [m.id, m.uses])).toEqual([["a", 1]]);
    expect(page.more).toBe(true);
  });

  it("random: the same seed gives the same order, and pages cover every meme once", async () => {
    for (let i = 0; i < 12; i++) await add(93, `r${i}`, i);
    const all = await ids(93, "random", { seed: 12345 });
    expect(all).toEqual(await ids(93, "random", { seed: 12345 }));
    expect(new Set(all).size).toBe(12);
    const pages = [...(await ids(93, "random", { seed: 12345, limit: 5 })), ...(await ids(93, "random", { seed: 12345, limit: 5, offset: 5 })), ...(await ids(93, "random", { seed: 12345, limit: 5, offset: 10 }))];
    expect(pages).toEqual(all);
  });

  it("time: older memes from the point down, newer ones up, nearest first", async () => {
    await add(94, "t1", 400 * DAY);
    await add(94, "t2", 300 * DAY);
    await add(94, "t3", 100 * DAY, 365 * DAY); // liked a year ago: the like time counts
    await add(94, "t4", 10 * DAY);
    const point = now - 365 * DAY;
    expect(await ids(94, "time", { seed: point })).toEqual(["t3", "t1"]);
    expect(await ids(94, "time", { seed: point, newer: true })).toEqual(["t2", "t4"]);
    expect(await ids(94, "time", { seed: point, newer: true, offset: 1 })).toEqual(["t4"]);
  });

  it("porn: only porn memes, also when they are hidden", async () => {
    await add(89, "pn", 2);
    await add(89, "px", 1);
    await e.DB.prepare("UPDATE memes SET porn = 1 WHERE id = 'px'").run();
    expect(await ids(89, "porn")).toEqual(["px"]);
    expect((await feedPage(e.DB, 89, { mode: "porn", seed: 1, offset: 0, limit: 50, hidePorn: true })).memes.map((m) => m.id)).toEqual(["px"]);
  });

  it("unseen: memes seen before the session go away, seen ones keep their place in it", async () => {
    await add(95, "s1", 1);
    await add(95, "s2", 2);
    await add(95, "s3", 3);
    await add(96, "theirs", 1);
    await e.DB.prepare("INSERT INTO meme_views (user_id, meme_id, seen_at) VALUES (95, 's2', ?)").bind(now - 100).run();
    expect(await ids(95, "unseen", { seed: now })).toEqual(["s1", "s3"]);
    await markSeen(e.DB, 95, ["s1", "theirs"]); // seen in this session: stays
    expect(await ids(95, "unseen", { seed: now - 10 })).toEqual(["s1", "s3"]);
    expect(await ids(95, "unseen", { seed: now + 10 })).toEqual(["s3"]);
    await markSeen(e.DB, 95, ["s1"]);
    expect(await e.DB.prepare("SELECT views FROM meme_views WHERE meme_id = 's1'").first("views")).toBe(2);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM meme_views WHERE meme_id = 'theirs'").first("n")).toBe(0);
  });
});

describe("feed API", () => {
  it("serves pages with file URLs and use counts, rejects bad modes, marks memes seen", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (97, 'user')").run();
    await add(97, "p1", 1);
    await use(97, "p1");
    const auth = { Authorization: `tma ${await initData(e.BOT_TOKEN, { id: 97, first_name: "A" })}` };
    const req = async (path: string, init: RequestInit = {}) =>
      (await handleApp(new Request(`https://m.example/app/api/${path}`, { ...init, headers: { ...auth, "Content-Type": "application/json" } }), e, ctx))!;

    const page = await (await req("feed?mode=favorites")).json<any>();
    expect(page.next_offset).toBeNull();
    expect(page.items).toMatchObject([{ id: "p1", uses: 1, file: expect.stringMatching(/^https:\/\/m\.example\/app\/file\/p1\?e=/) }]);
    expect((await req("feed?mode=nope")).status).toBe(400);
    expect((await req("feed/seen", { method: "POST", body: JSON.stringify({ ids: ["p1"] }) })).status).toBe(200);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM meme_views WHERE user_id = 97").first("n")).toBe(1);

    // An album: once, as its first meme, with all its memes in order in slides.
    for (const [id, pos] of [["fa2", 2], ["fa1", 1]] as const) await add(97, id, 2), await addToPost(e.DB, 97, { memeId: id, mediaGroupId: "g", position: pos });
    const all = (await (await req("feed?mode=new")).json<any>()).items;
    expect(all.map((m: any) => [m.id, m.album, m.slides?.map((x: any) => x.id)])).toEqual([["p1", undefined, undefined], ["fa1", 2, ["fa1", "fa2"]]]);
    expect(all[1].slides[1].file).toMatch(/\/app\/file\/fa2\?e=/);
  });
});

describe("bot feed", () => {
  it("edits the message media to the next meme and says when there is none", async () => {
    await add(98, "b1", 2);
    await add(98, "b2", 1);
    const calls: { method: string; body: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ method: String(url).split("/").pop()!, body: String(init?.body) });
      return Response.json({ ok: true, result: { message_id: 7, date: 0, chat: { id: 98, type: "private" }, photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }] } });
    });
    const api = new Api("1:test");
    expect(await showFeed(e, api, 98, { id: 98, hide_porn: 0 }, "en", "new", 1, 0)).toBe(true);
    expect(await showFeed(e, api, 98, { id: 98, hide_porn: 0 }, "en", "new", 1, 1, 7)).toBe(true);
    expect(await showFeed(e, api, 98, { id: 98, hide_porn: 0 }, "en", "new", 1, 2, 7)).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto", "editMessageMedia"]);
    const edit = JSON.parse(calls[1].body);
    expect(edit).toMatchObject({ chat_id: 98, message_id: 7, media: { type: "photo", media: "f", parse_mode: "HTML" } });
    expect(edit.media.caption).toContain("#2");
    const nav = edit.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data);
    expect(nav).toEqual(["f:n:1:0"]); // back only: b1 is the last one

    // time mode: ◀ goes to newer memes, above the point (negative offsets)
    calls.length = 0;
    expect(await showFeed(e, api, 98, { id: 98, hide_porn: 0 }, "en", "time", now - 2, 0, 7)).toBe(true);
    const time = JSON.parse(calls[0].body).reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data);
    expect(time).toEqual([`f:t:${(now - 2).toString(36)}:-1`]); // b1 is the oldest, b2 is newer
    expect(await showFeed(e, api, 98, { id: 98, hide_porn: 0 }, "en", "time", now - 2, -1, 7)).toBe(true);
    expect(await showFeed(e, api, 98, { id: 98, hide_porn: 0 }, "en", "time", now - 2, -2, 7)).toBe(false);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM meme_views WHERE user_id = 98").first("n")).toBe(2);
  });
});

describe("hide porn setting", () => {
  it("hides porn memes from the library, index, search results and feed, keeps them saved", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (99, 'user')").run();
    await add(99, "clean", 2);
    await add(99, "nsfw", 1);
    await e.DB.prepare("UPDATE memes SET porn = 1 WHERE id = 'nsfw'").run();
    const auth = { Authorization: `tma ${await initData(e.BOT_TOKEN, { id: 99, first_name: "A" })}` };
    const req = async (path: string, init: RequestInit = {}) =>
      (await handleApp(new Request(`https://m.example/app/api/${path}`, { ...init, headers: { ...auth, "Content-Type": "application/json" } }), e, ctx))!;
    const listed = async (path: string) => {
      const body = await (await req(path)).json<any>();
      return (body.items ?? body).map((m: any) => m.id); // index is a plain array
    };

    expect(await listed("memes")).toEqual(["nsfw", "clean"]);
    expect((await (await req("me")).json<any>()).hide_porn).toBe(false);
    expect((await req("settings", { method: "PUT", body: JSON.stringify({ hide_porn: true }) })).status).toBe(200);
    expect((await (await req("me")).json<any>()).hide_porn).toBe(true);
    expect(await listed("memes")).toEqual(["clean"]);
    expect(await listed("index")).toEqual(["clean"]);
    expect(await listed("feed?mode=new")).toEqual(["clean"]);
    expect(await listed("feed?mode=porn")).toEqual(["nsfw"]); // the porn mode ignores the setting
    // the porn filter overrides the setting
    expect(await listed("memes?porn=yes")).toEqual(["nsfw"]);
    expect(await listed("memes?porn=yes,no")).toEqual(["nsfw", "clean"]);
    expect(await listed("index?porn=yes,no")).toEqual(["nsfw", "clean"]);
    expect(visible({ hide_porn: 1 }, [{ porn: 1 }, { porn: 0 }], ["yes"])).toEqual([{ porn: 1 }]);
    expect(visible({ hide_porn: 1 }, [{ porn: 1 }, { porn: 0 }])).toEqual([{ porn: 0 }]);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM memes WHERE user_id = 99").first("n")).toBe(2); // still saved
  });
});
