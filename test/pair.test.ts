import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBot } from "../src/bot";
import type { User } from "../src/db";
import type { Env } from "../src/env";
import { acceptPair, canView, createInvite, declinePair, endPair, expireInvites, listPairs, setShares } from "../src/pairs";
import { pairMarkdown } from "../src/pairreport";
import { pairStats } from "../src/pairstats";
import { createToken } from "../src/tokens";
import { deleteAccount } from "../src/purge";
import { handleApp } from "../src/webapp";

const e = { ...env, PUBLIC_URL: "https://m.example", JOBS: { send: async () => {} } } as unknown as Env;
const db = e.DB;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let calls: { method: string; body: any }[] = [];
let blocked = new Set<number>();
beforeEach(() => {
  calls = [];
  blocked = new Set();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = String(input).split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, body });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "b", username: "memebot" } });
    if (blocked.has(body.chat_id)) return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
    if (method === "savePreparedKeyboardButton") return Response.json({ ok: true, result: { id: "btn1" } });
    if (method === "savePreparedInlineMessage") return Response.json({ ok: true, result: { id: "prep1", expiration_date: 0 } });
    return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: body.chat_id, type: "private" }, text: "x" } });
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
const api = (userId: number) => async (path: string, init: RequestInit = {}) => {
  const auth = `tma ${await initData({ id: userId, first_name: `U${userId}` })}`;
  return (await handleApp(new Request(`https://m.example/app/api/${path}`, { ...init, headers: { Authorization: auth, "Content-Type": "application/json" } }), e, ctx))!;
};
const users = (...ids: number[]) => db.prepare(`INSERT INTO users (id, role) VALUES ${ids.map((id) => `(${id}, 'user')`).join(",")}`).run();
const meme = (user: number, id: string, extra: { fu?: string; sha?: string; tags?: string; ago?: number } = {}) =>
  db
    .prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, sha256, status, tags, created_at) VALUES (?, ?, 'photo', 'f', ?, ?, 'ready', ?, unixepoch() - ?)")
    .bind(id, user, extra.fu ?? `u_${id}`, extra.sha ?? null, extra.tags ?? null, extra.ago ?? 0)
    .run();
/** An active pair of a and b. */
async function pair(a: number, b: number) {
  const p = (await createInvite(db, a, `A${a}`, b, `B${b}`))!;
  return (await acceptPair(db, p.id, b, `B${b}`))!;
}

describe("pairs", () => {
  it("creates, accepts, declines and ends; no self, no duplicates, a limit", async () => {
    expect(await createInvite(db, 101, "A", 101)).toBeNull();
    const p = (await createInvite(db, 101, "A", 102, "B"))!;
    expect(p).toMatchObject({ a: 101, b: 102, status: "pending" });
    expect(p.id).toMatch(/^[\w-]{12}$/);
    expect((await createInvite(db, 102, "B", 101))!.id).toBe(p.id); // the same pair either way
    expect(await acceptPair(db, p.id, 103, "C")).toBeNull(); // only b
    expect(await acceptPair(db, p.id, 101, "A")).toBeNull();
    expect(await acceptPair(db, p.id, 102, "Bob")).toMatchObject({ status: "active", b_name: "Bob" });
    expect(await declinePair(db, p.id, 102)).toBeNull(); // active: not an invite any more

    const open = (await createInvite(db, 101, "A"))!;
    expect(open.b).toBeNull();
    expect(await acceptPair(db, open.id, 102, "B")).toBeNull(); // already a pair with 101
    expect(await acceptPair(db, open.id, 104, "D")).toMatchObject({ b: 104, status: "active" });

    const inv = (await createInvite(db, 101, "A", 105))!;
    expect(await declinePair(db, inv.id, 101)).toBeNull();
    expect(await declinePair(db, inv.id, 105)).not.toBeNull();
    expect(await endPair(db, p.id, 103)).toBeNull();
    expect(await endPair(db, p.id, 101)).not.toBeNull();
    expect((await listPairs(db, 101)).map((v) => v.partner.id)).toEqual([104]);

    const link = (await createInvite(db, 106, "E"))!;
    expect((await createInvite(db, 106, "E"))!.id).toBe(link.id); // one open link, not a row per click
    for (let i = 0; i < 19; i++) expect(await createInvite(db, 106, "E", 300 + i)).not.toBeNull();
    expect(await createInvite(db, 106, "E", 107)).toBeNull();
    expect((await createInvite(db, 106, "E"))!.id).toBe(link.id);
    await db.prepare("UPDATE pairs SET created_at = created_at - 8 * 86400 WHERE a = 106").run();
    await expireInvites(db);
    expect(await listPairs(db, 106)).toEqual([]);

    // The accepting side is limited too.
    for (let i = 0; i < 20; i++) await createInvite(db, 400 + i, "F", 108);
    const last = (await createInvite(db, 420, "F"))!;
    for (const x of await listPairs(db, 108)) if (x.partner.id !== 400) await acceptPair(db, x.id, 108, "H");
    expect(await acceptPair(db, last.id, 108, "H")).toBeNull();
    expect(await acceptPair(db, (await listPairs(db, 108)).find((x) => x.partner.id === 400)!.id, 108, "H")).not.toBeNull();
  });

  it("canView follows the active status and the owner's share flag", async () => {
    const p = (await createInvite(db, 111, "A", 112))!;
    expect(await canView(db, 112, 111)).toBe(false);
    await acceptPair(db, p.id, 112, "B");
    expect(await canView(db, 112, 111)).toBe(true);
    expect(await canView(db, 111, 112)).toBe(true);
    await setShares(db, p.id, 111, false);
    expect(await canView(db, 112, 111)).toBe(false);
    expect(await canView(db, 111, 112)).toBe(true);
    expect((await listPairs(db, 112))[0]).toMatchObject({ i_share: true, they_share: false, incoming: false, partner: { id: 111, name: "A" } });
    expect(await canView(db, 113, 111)).toBe(false);
  });
});

describe("owner mode", () => {
  it("reads a partner's memes only while they share, never writes", async () => {
    await users(121, 122, 123);
    await meme(121, "own1");
    await meme(122, "par1", { tags: "cat" });
    await meme(122, "par2");
    const as121 = api(121);
    const ids = async (path: string) => {
      const body = await (await as121(path)).json<any>();
      return (body.items ?? body).map((m: any) => m.id).sort();
    };
    expect((await as121("memes?owner=122")).status).toBe(403); // no pair
    const p = await pair(121, 122);
    expect(await ids("memes?owner=122")).toEqual(["par1", "par2"]);
    expect(await ids("index?owner=122")).toEqual(["par1", "par2"]);
    expect(await ids("memes?owner=122&ids=par2,own1")).toEqual(["par2"]);
    expect(await ids("search?owner=122&mode=fts&q=zz")).toEqual([]);
    expect(await (await as121("tags?owner=122")).json()).toEqual([{ tag: "cat", count: 1 }]);
    expect((await as121("memes/par1?owner=122")).status).toBe(200);
    expect((await as121("memes/par1")).status).toBe(404);
    expect((await as121("memes/own1?owner=122")).status).toBe(404);
    expect((await as121("search?owner=122&mode=fast&q=cat")).status).toBe(400);
    expect((await as121("memes/par1?owner=122", { method: "DELETE" })).status).toBe(403);
    expect((await as121("memes/par1", { method: "DELETE" })).status).toBe(404);
    expect((await as121("memes?owner=123")).status).toBe(403);

    expect((await as121("memes/par1/send", { method: "POST" })).status).toBe(200); // to the viewer's own chat
    expect(calls.find((c) => c.method === "sendPhoto")?.body).toMatchObject({ chat_id: 121 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM meme_uses WHERE meme_id = 'par1'").first("n")).toBe(0);

    await setShares(db, p.id, 122, false);
    expect((await as121("memes?owner=122")).status).toBe(403);
    expect((await as121("memes/par1/send", { method: "POST" })).status).toBe(404);
  });
});

describe("pairs API", () => {
  it("invites by link, accepts, shares and serves stats to members only", async () => {
    await users(131, 132, 133);
    const [as131, as132, as133] = [api(131), api(132), api(133)];
    const inv = await (await as131("pairs", { method: "POST" })).json<any>();
    expect(inv).toMatchObject({ link: `https://t.me/memebot?start=pair_${inv.id}`, prepared: "prep1" });
    expect(calls.find((c) => c.method === "savePreparedInlineMessage")?.body.result.reply_markup.inline_keyboard[0][0].url).toBe(inv.link);
    expect((await as131(`pairs/${inv.id}/stats`)).status).toBe(403); // pending
    const view = await (await as132(`pairs/${inv.id}/accept`, { method: "POST" })).json<any>();
    expect(view).toMatchObject({ id: inv.id, status: "active", incoming: false, partner: { id: 131, name: "U131" }, i_share: true, they_share: true });
    expect(await (await as131("pairs")).json()).toMatchObject({ bot: "memebot", pairs: [{ partner: { id: 132, name: "U132" } }] });
    expect(await (await as132(`pairs/${inv.id}/share`, { method: "POST", body: JSON.stringify({ on: false }) })).json()).toMatchObject({ i_share: false });
    expect((await as132(`pairs/${inv.id}/share`, { method: "POST", body: "{" })).status).toBe(400);
    expect((await as131(`pairs/${inv.id}/stats`)).status).toBe(200);
    expect((await as133(`pairs/${inv.id}/stats`)).status).toBe(403);
    expect((await as133(`pairs/${inv.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await as131(`pairs/${inv.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await listPairs(db, 132)).toEqual([]);
  });

  it("prepares Telegram's user picker for the Mini App", async () => {
    await users(134);
    expect(await (await api(134)("pairs/pick", { method: "POST" })).json()).toEqual({ id: "btn1" });
    const c = calls.find((c) => c.method === "savePreparedKeyboardButton")!;
    expect(c.body).toMatchObject({ user_id: 134, button: { request_users: { request_id: 1, user_is_bot: false, max_quantity: 1 } } });
  });
});

describe("pair bot", () => {
  const msg = (from: number, extra: object) => ({
    update_id: 1,
    message: { message_id: 1, date: 0, chat: { id: from, type: "private", first_name: `N${from}` }, from: { id: from, is_bot: false, first_name: `N${from}` }, ...extra },
  });
  const tap = (from: number, data: string) => ({
    update_id: 2,
    callback_query: { id: "q", chat_instance: "i", data, from: { id: from, is_bot: false, first_name: `N${from}` }, message: { message_id: 5, date: 0, chat: { id: from, type: "private" }, text: "x" } },
  });
  const shared = (from: number, to: number) => msg(from, { users_shared: { request_id: 1, users: [{ user_id: to, first_name: `N${to}` }] } });
  const sent = (chat: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chat);

  it("sends the consent card to the picked user; only they can accept, and the inviter hears back", async () => {
    const bot = createBot(e);
    await bot.init();
    await bot.handleUpdate(shared(141, 142) as any);
    const card = sent(142)[0].body;
    expect(card.text).toContain("N141");
    const [ok, no] = card.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data);
    expect(no).toBe(ok.replace("ok", "no"));
    expect(sent(141).at(-1)!.body.reply_markup).toEqual({ remove_keyboard: true });

    await bot.handleUpdate(tap(143, ok) as any);
    expect(calls.find((c) => c.method === "editMessageText")!.body.text).toContain("no longer valid");
    await bot.handleUpdate(tap(142, ok) as any);
    expect(await canView(db, 141, 142)).toBe(true);
    await bot.handleUpdate(tap(141, `pair:share:${ok.slice(-12)}:0`) as any);
    expect(await canView(db, 142, 141)).toBe(false);
    expect(sent(141).at(-1)!.body.text).toContain("N142");
    expect(sent(141).at(-1)!.body.reply_markup.inline_keyboard[0][0].web_app.url).toMatch(/^https:\/\/m\.example\/\?pair=[\w-]{12}$/);
  });

  it("asks before inviting a shared contact card", async () => {
    await users(148);
    const bot = createBot(e);
    await bot.init();
    await bot.handleUpdate(msg(147, { contact: { phone_number: "1", first_name: "Kate", user_id: 148 } }) as any);
    const ask = sent(147).at(-1)!.body;
    expect(ask.text).toContain("Kate");
    expect(sent(148)).toHaveLength(0);
    await bot.handleUpdate(tap(147, ask.reply_markup.inline_keyboard[0][0].callback_data) as any);
    expect(sent(148)[0].body.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^pair:ok:/);
    await bot.handleUpdate(msg(147, { contact: { phone_number: "2", first_name: "Nobody" } }) as any);
    expect(sent(147).at(-1)!.body.text).toContain("/pair");
  });

  it("refuses to pair with yourself", async () => {
    const bot = createBot(e);
    await bot.init();
    await bot.handleUpdate(shared(146, 146) as any);
    expect(sent(146).at(-1)!.body.text).toContain("yourself");
    expect(await listPairs(db, 146)).toEqual([]);
  });

  it("gives the inviter a link when the picked user never started the bot", async () => {
    blocked.add(145);
    const bot = createBot(e);
    await bot.init();
    await bot.handleUpdate(shared(144, 145) as any);
    const id = (await listPairs(db, 144))[0].id;
    expect(sent(144).at(-1)!.body.text).toContain(`https://t.me/memebot?start=pair_${id}`);
    blocked.clear(); // now 145 opens the link
    await bot.handleUpdate(msg(145, { text: `/start pair_${id}`, entities: [{ type: "bot_command", offset: 0, length: 6 }] }) as any);
    expect(sent(145).at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data).toBe(`pair:ok:${id}`);
  });
});

describe("pair stats", () => {
  it("finds twins by file id or content hash, compares tags and tells who saved first", async () => {
    await meme(151, "x1", { fu: "same", tags: "cat\ndog", ago: 100 });
    await meme(152, "y1", { fu: "same", tags: "cat", ago: 50 });
    await meme(151, "x2", { sha: "h", tags: "cat", ago: 10 });
    await meme(152, "y2", { sha: "h", tags: "frog", ago: 20 });
    await meme(152, "y3", { tags: "cat" });
    await pair(151, 152);
    const st = await pairStats(e, 151, 152);
    expect(st.me).toMatchObject({ id: 151, name: "A151", ready: 2 });
    expect(st.partner).toMatchObject({ id: 152, name: "B152", ready: 3 });
    expect(st.shared.twins.count).toBe(2);
    expect(st.shared.twins.items.map((t) => [t[0], t[1]]).sort()).toEqual([["x1", "y1"], ["x2", "y2"]]);
    expect(st.shared.twins.first).toEqual({ me: 1, partner: 1 });
    expect(st.shared.tags).toEqual([{ tag: "cat", me: 2, partner: 2 }]);
    expect(st.shared.jaccard).toBeCloseTo(2 / 4); // min: cat 2; max: cat 2, dog 1, frog 1
    expect(st.shared.unique_me).toEqual([{ tag: "dog", count: 1 }]);
    expect(st.shared.unique_partner).toEqual([{ tag: "frog", count: 1 }]);
    expect(st.compat).toBeGreaterThan(0);
    expect(st.compat).toBeLessThanOrEqual(100);
  });
});

describe("pair stats twins", () => {
  it("counts an own meme once and skips failed ones", async () => {
    await meme(171, "tx1", { sha: "h", ago: 10 });
    await meme(171, "tx2", { sha: "h", ago: 10 }); // same content as x1: two own memes, two twins
    await meme(172, "ty1", { sha: "h", fu: "f1", ago: 20 });
    await meme(172, "ty2", { sha: "h", fu: "f2", ago: 30 }); // a second partner copy of x1 and x2: still one twin each
    await meme(171, "tx3", { fu: "gone" });
    await meme(172, "ty3", { fu: "gone" });
    await db.prepare("UPDATE memes SET status = 'failed' WHERE id IN ('tx3', 'ty3')").run();
    await pair(171, 172);
    const t = (await pairStats(e, 171, 172)).shared.twins;
    expect(t.count).toBe(2);
    expect(t.items.map((i) => i[0]).sort()).toEqual(["tx1", "tx2"]);
    expect(t.first).toEqual({ me: 0, partner: 2 });
  });
});

describe("pair porn stats", () => {
  const porn = (id: string) => db.prepare("UPDATE memes SET porn = 1 WHERE id = ?").bind(id).run();
  it("compares porn tags and twins; hidden by either side or when nobody has porn", async () => {
    await users(391, 392);
    await meme(391, "px1", { fu: "pp", tags: "cat\nfur", ago: 100 });
    await meme(392, "py1", { fu: "pp", tags: "cat", ago: 50 });
    await meme(391, "px2", { tags: "dog" });
    await meme(392, "py2", { tags: "fur" });
    await pair(391, 392);
    expect((await pairStats(e, 391, 392)).porn).toBeNull(); // both sides 0
    await Promise.all(["px1", "py1", "py2"].map(porn));
    const p = (await pairStats(e, 391, 392)).porn!;
    expect(p.me).toMatchObject({ ready: 2, porn: 1 });
    expect(p.partner).toMatchObject({ ready: 2, porn: 2 });
    expect(p.tags).toEqual([{ tag: "cat", me: 1, partner: 1 }, { tag: "fur", me: 1, partner: 1 }]);
    expect(p.jaccard).toBeCloseTo(2 / 2); // min: cat 1, fur 1; max: the same
    expect(p.twins).toEqual({ count: 1, first: { me: 1, partner: 0 } });
    await db.prepare("UPDATE users SET hide_porn = 1 WHERE id = 392").run();
    expect((await pairStats(e, 391, 392)).porn).toBeNull();
    expect((await pairStats(e, 392, 391)).porn).toBeNull();
  });

  it("shows the porn part of the pair report only when asked", () => {
    const side = { ready: 10, porn: 5 };
    const r = { analytics: { me: { name: "Ann" }, partner: { name: "Bob" }, porn: { me: side, partner: null, tags: [], jaccard: 0.25, twins: { count: 3, first: { me: 2, partner: 1 } } } }, clusters: [], twins: [], influence: { twins: [0, 0] }, scores: { compat: 50 } } as any;
    const img = (name: string) => `![](${name})`;
    const on = pairMarkdown("en", r, img, true);
    expect(on).toContain("## Porn");
    expect(on).toContain("Ann 50%, Bob 0%");
    expect(on).toContain("![](pair_porn_tags)");
    expect(pairMarkdown("en", r, img)).not.toContain("## Porn");
  });
});

describe("owner mode with a token", () => {
  it("rejects ?owner for API tokens", async () => {
    await users(181, 182);
    await meme(182, "tpar1");
    await pair(181, 182);
    const token = await createToken(db, 181, "t", false);
    const get = (path: string) => handleApp(new Request(`https://m.example/app/api/${path}`, { headers: { Authorization: `Bearer ${token!.token}` } }), e, ctx);
    expect((await get("memes?owner=182"))!.status).toBe(403);
    expect((await get("pairs"))!.status).toBe(403);
  });

  it("accepting in the app tells the inviter, sends both cards and tries the analysis", async () => {
    await users(191, 192);
    const p = (await createInvite(db, 191, "A191", 192, "B192"))!;
    expect((await api(192)(`pairs/${p.id}/accept`, { method: "POST" })).status).toBe(200);
    expect(calls.find((c) => c.method === "sendMessage" && c.body.chat_id === 191)!.body.text).toContain("U192");
    expect(calls.filter((c) => c.method === "sendWidget" || c.method === "sendSharedWidget").map((c) => c.body.chat_id).sort()).toEqual([191, 192]);
    expect((await api(191)(`pairs/${p.id}`, { method: "DELETE" })).status).toBe(200);
    expect(calls.find((c) => c.method === "sendMessage" && c.body.chat_id === 192)!.body.text).toContain("A191"); // the partner hears of the end
  });
});

describe("delete account", () => {
  it("deletes the user's pairs on both sides", async () => {
    await users(161);
    await pair(161, 162);
    await pair(163, 161);
    await pair(163, 164);
    await deleteAccount(e, (await db.prepare("SELECT * FROM users WHERE id = 161").first<User>())!);
    expect(await db.prepare("SELECT a, b FROM pairs WHERE a IN (161, 162, 163) OR b IN (161, 162, 163)").all().then((r) => r.results)).toEqual([{ a: 163, b: 164 }]);
  });
});
