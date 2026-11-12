import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resultKey } from "../src/analysis";
import { createBot } from "../src/bot";
import type { Env } from "../src/env";
import { feedPage } from "../src/feed";
import { acceptPair, createInvite, setShares } from "../src/pairs";
import { handleApp } from "../src/webapp";

const upserted: VectorizeVector[] = [];
const VECTORS = {
  getByIds: async (ids: string[]) => ids.map((id) => ({ id, values: [1, 0], metadata: { kind: "photo" } })),
  upsert: async (v: VectorizeVector[]) => (upserted.push(...v), { count: v.length }),
};
const e = { ...env, PUBLIC_URL: "https://m.example", VECTORS, JOBS: { send: async () => {} } } as unknown as Env;
const db = e.DB;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let calls: { method: string; body: any }[] = [];
beforeEach(() => {
  calls = [];
  upserted.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = String(input).split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, body });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "b", username: "memebot" } });
    return Response.json({ ok: true, result: { message_id: 7, date: 0, chat: { id: body.chat_id, type: "private" }, photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }] } });
  });
});
afterEach(() => vi.restoreAllMocks());

const enc = (s: string) => new TextEncoder().encode(s);
async function hmac(key: BufferSource, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc(data)));
}
async function initData(user: object) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  params.set("hash", [...(await hmac(await hmac(enc("WebAppData"), e.BOT_TOKEN), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return params.toString();
}
const api = (userId: number) => async (path: string, body?: unknown) => {
  const auth = `tma ${await initData({ id: userId, first_name: `U${userId}` })}`;
  const init = body === undefined ? {} : { method: "POST", body: JSON.stringify(body) };
  return (await handleApp(new Request(`https://m.example/app/api/${path}`, { ...init, headers: { Authorization: auth, "Content-Type": "application/json" } }), e, ctx))!;
};
const users = (...ids: number[]) => db.prepare(`INSERT INTO users (id, role) VALUES ${ids.map((id) => `(${id}, 'user')`).join(",")}`).run();
const meme = (user: number, id: string, extra: { fu?: string; sha?: string; ago?: number; r2?: string } = {}) =>
  db
    .prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, sha256, status, title, r2_file, created_at) VALUES (?, ?, 'photo', 'f', ?, ?, 'ready', ?, ?, unixepoch() - ?)")
    .bind(id, user, extra.fu ?? `u_${id}`, extra.sha ?? null, `T ${id}`, extra.r2 ?? null, extra.ago ?? 0)
    .run();
async function pair(a: number, b: number) {
  const p = (await createInvite(db, a, `A${a}`, b, `B${b}`))!;
  return (await acceptPair(db, p.id, b, `B${b}`))!;
}
/** A finished pair analysis with its result in R2 (owners: a, b). */
async function result(pairId: string, a: number, b: number, r: object) {
  const id = `an_${pairId}`;
  await db.prepare("INSERT INTO analyses (id, user_id, pair_id, status) VALUES (?, ?, ?, 'done')").bind(id, a, pairId).run();
  await e.MEDIA.put(resultKey(id), JSON.stringify({ twins: [], rhymes: [], for: [[], []], surprise: [[], []], bridge: [], owners: [a, b], ...r }));
}
const ids = (body: any) => body.items.map((x: any) => x.id);

describe("pair feed", () => {
  it("feedPage takes several users", async () => {
    await meme(701, "m1", { ago: 2 });
    await meme(702, "m2", { ago: 1 });
    await meme(703, "m3");
    expect((await feedPage(db, [701, 702], { mode: "new", seed: 1, offset: 0, limit: 10 })).memes.map((m) => m.id)).toEqual(["m2", "m1"]);
  });

  it("modes, owners, list modes from the R2 result, a revoke hides the partner", async () => {
    await users(711, 712);
    const p = await pair(711, 712);
    for (const [u, id] of [[711, "a1"], [711, "a2"], [712, "b1"], [712, "b2"]] as const) await meme(u, id);
    const me = api(712); // side b of the result

    let page = await (await me(`pairs/${p.id}/feed?mode=mix&seed=5`)).json<any>();
    expect(page.modes).toEqual(["mix", "theirs", "guess"]);
    expect(new Set(ids(page))).toEqual(new Set(["a1", "a2", "b1", "b2"]));
    expect(page.items.find((x: any) => x.id === "a1").owner).toBe("partner");
    expect(page.items.find((x: any) => x.id === "b1")).toMatchObject({ owner: "me", file: expect.stringContaining("/app/file/b1") });
    expect((await me(`pairs/${p.id}/feed?mode=twins`)).status).toBe(400);

    await result(p.id, 711, 712, { twins: [["a1", "b2", 0.99]], rhymes: [["a2", "b1", 0.9]], for: [["b1"], ["a2", "a1"]], bridge: ["a1", "b1"] });
    page = await (await me(`pairs/${p.id}/feed?mode=twins`)).json<any>();
    expect(page.modes).toEqual(["mix", "theirs", "twins", "rhymes", "foryou", "bridge", "guess"]);
    expect(ids(page)).toEqual(["b2", "a1"]); // own meme first
    expect(ids(await (await me(`pairs/${p.id}/feed?mode=foryou`)).json())).toEqual(["a2", "a1"]);
    expect(ids(await (await me(`pairs/${p.id}/feed?mode=bridge`)).json())).toEqual(["b1", "a1"]);
    expect(ids(await (await api(711)(`pairs/${p.id}/feed?mode=rhymes`)).json())).toEqual(["a2", "b1"]);

    await setShares(db, p.id, 711, false);
    page = await (await me(`pairs/${p.id}/feed?mode=mix&seed=5`)).json<any>();
    expect(page.modes).toEqual(["mix"]);
    expect(new Set(ids(page))).toEqual(new Set(["b1", "b2"]));
    expect((await me(`pairs/${p.id}/feed?mode=theirs`)).status).toBe(400);
    expect((await api(713)(`pairs/${p.id}/feed?mode=mix`)).status).toBe(403);
  });

  it("theirs: partner memes unseen by the viewer first; seen marks partner memes for the viewer", async () => {
    await users(721, 722);
    const p = await pair(721, 722);
    await meme(722, "t1", { ago: 3 });
    await meme(722, "t2", { ago: 2 });
    await meme(722, "t3", { ago: 1 });
    await meme(721, "own");
    const me = api(721);
    expect((await me(`pairs/${p.id}/feed/seen`, { ids: ["t3", "own"] })).status).toBe(200);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM meme_views WHERE user_id = 721").first("n")).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM meme_views WHERE user_id = 722").first("n")).toBe(0);
    await db.prepare("UPDATE meme_views SET seen_at = seen_at - 100").run();
    const page = await (await me(`pairs/${p.id}/feed?mode=theirs&seed=${Math.floor(Date.now() / 1000)}`)).json<any>();
    expect(ids(page)).toEqual(["t2", "t1", "t3"]);
  });

  it("guess hides the owner and checks the answer on the server", async () => {
    await users(731, 732);
    const p = await pair(731, 732);
    await meme(731, "g1");
    await meme(732, "g2");
    await meme(733, "stranger");
    const me = api(731);
    const page = await (await me(`pairs/${p.id}/feed?mode=guess&seed=3`)).json<any>();
    expect(page.items).toHaveLength(2);
    expect(page.items.every((x: any) => !("owner" in x))).toBe(true);
    expect(await (await me(`pairs/${p.id}/guess`, { id: "g2", owner: "partner" })).json()).toEqual({ correct: true, owner: "partner" });
    expect(await (await me(`pairs/${p.id}/guess`, { id: "g1", owner: "partner" })).json()).toEqual({ correct: false, owner: "me" });
    expect((await me(`pairs/${p.id}/guess`, { id: "stranger", owner: "me" })).status).toBe(404);
  });

  it("no porn for either side when one member of the pair hides it", async () => {
    await users(761, 762);
    const p = await pair(761, 762);
    await meme(761, "x1");
    await meme(761, "x2");
    await meme(762, "y1");
    await db.prepare("UPDATE memes SET porn = 1 WHERE id IN ('x2', 'y1')").run();
    const feed = async (u: number, mode: string) => ids(await (await api(u)(`pairs/${p.id}/feed?mode=${mode}&seed=5`)).json());
    expect((await feed(761, "mix")).sort()).toEqual(["x1", "x2", "y1"]);
    expect(await feed(762, "theirs")).toEqual(expect.arrayContaining(["x1", "x2"]));
    await db.prepare("UPDATE users SET hide_porn = 1 WHERE id = 762").run();
    for (const [u, mode] of [[761, "mix"], [762, "mix"], [761, "guess"], [762, "theirs"]] as const) expect(await feed(u, mode)).toEqual(expect.not.arrayContaining(["x2", "y1"]));
    expect((await feed(761, "mix")).sort()).toEqual(["x1"]);
    expect(await feed(762, "theirs")).toEqual(["x1"]);
  });

  it("copy: a new own meme with R2 files and vectors, dedupe, no access without a pair", async () => {
    await users(741, 742, 743);
    await pair(741, 742);
    await e.MEDIA.put("u/742/h.jpg", "jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    await meme(742, "c1", { r2: "u/742/h.jpg", sha: "h" });
    await meme(742, "c2", { sha: "h2" });
    await meme(741, "mine", { sha: "h2" });
    const me = api(741);

    const copy = await (await me("memes/c1/copy", {})).json<{ id: string; duplicate: boolean }>();
    expect(copy.duplicate).toBe(false);
    const row = await db.prepare("SELECT * FROM memes WHERE id = ?").bind(copy.id).first<any>();
    expect(row).toMatchObject({ user_id: 741, added_via: "pair", status: "ready", title: "T c1", sha256: "h", r2_file: `memes/${copy.id}/h.jpg` });
    expect(await (await e.MEDIA.get(row.r2_file))!.text()).toBe("jpeg");
    expect(upserted.map((v) => [v.id, v.namespace])).toEqual([[`${copy.id}:i`, "u741"], [`${copy.id}:t`, "u741"]]);

    expect(await (await me("memes/c1/copy", {})).json()).toEqual({ id: copy.id, duplicate: true });
    expect(await (await me("memes/c2/copy", {})).json()).toEqual({ id: "mine", duplicate: true }); // same sha256
    expect((await api(743)("memes/c1/copy", {})).status).toBe(403);
  });
});

describe("bot pair feed", () => {
  const tap = (from: number, data: string, media = true) => ({
    update_id: 1,
    callback_query: {
      id: "q",
      chat_instance: "i",
      data,
      from: { id: from, is_bot: false, first_name: `N${from}` },
      message: { message_id: 5, date: 0, chat: { id: from, type: "private" }, ...(media ? { photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }] } : { text: "x" }) },
    },
  });

  it("pf shows whose meme, pg answers with a toast and goes on", async () => {
    await users(751, 752);
    const p = await pair(751, 752);
    await meme(751, "f1");
    await meme(752, "f2");
    const bot = createBot(e);
    await bot.init();

    await bot.handleUpdate(tap(751, `pf:${p.id}:x:5:0`, false) as any); // from the /pair card: a new message
    const sent = calls.find((c) => c.method === "sendPhoto")!.body;
    expect(sent.caption).toMatch(/Yours|B752's/);
    const buttons = sent.reply_markup.inline_keyboard.flat();
    expect(buttons.every((b: any) => !b.callback_data || b.callback_data.length <= 64)).toBe(true);
    const guess = buttons.find((b: any) => b.callback_data?.startsWith(`pf:${p.id}:g:`)).callback_data;

    calls = [];
    await bot.handleUpdate(tap(751, guess) as any);
    const shown = calls.find((c) => c.method === "editMessageMedia")!.body;
    expect(shown.media.caption).toContain("Whose meme");
    expect(shown.media.caption).not.toMatch(/Yours|B752's/);
    const [mine, theirs] = shown.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data);
    expect(mine).toMatch(new RegExp(`^pg:${p.id}:[0-9a-z]+:0:m$`));

    calls = [];
    const first = (await (await api(751)(`pairs/${p.id}/feed?mode=guess&seed=${parseInt(guess.split(":")[3], 36)}`)).json<any>()).items[0].id;
    await bot.handleUpdate(tap(751, first === "f1" ? mine : theirs) as any);
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.body.text).toBe("✅ Right!");
    expect(calls.find((c) => c.method === "editMessageMedia")!.body.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/:1:m$/);

    calls = [];
    await bot.handleUpdate(tap(751, (first === "f1" ? mine : theirs).replace(":0:", ":1:")) as any);
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.body.text).toMatch(/^❌ It's (your meme|B752's meme)\nNo more memes here$/);
  });
});
