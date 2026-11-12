import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBot } from "../src/bot";
import { connectE621, disconnectE621, e621Status, e621Sync, queueE621, setE621Lists, setE621Pools } from "../src/e621";
import type { Env } from "../src/env";
import { saveDescription, toDescription } from "../src/ingest/describe";
import { galleryJob, gallerySource, startGallery } from "../src/ingest/gallery";
import { scraper } from "../src/ingest/scraper";
import { E621Error, type Post } from "../src/ingest/sources/e621";
import { getMeme } from "../src/db";

afterEach(() => vi.restoreAllMocks());

const jobs: any[] = [];
const c = { ...env, JOBS: { send: async (b: unknown) => void jobs.push(b) } } as unknown as Env;
const user = async (id: number) => void (await c.DB.prepare("INSERT INTO users (id, role, lang) VALUES (?, 'user', 'en')").bind(id).run());
const S = "https://static1.e621.net";

const post = (id: number, o: Partial<Post> = {}) =>
  ({
    id,
    rating: "s",
    file: { ext: "jpg", size: 1000, url: `${S}/data/${id}.jpg` },
    sample: { url: `${S}/sample/${id}.jpg`, alternates: {} },
    tags: { general: [`tag${id}`], artist: ["bob"], species: ["wolf"], invalid: ["bad"] },
    pools: [],
    ...o,
  }) as Post;
const mp4 = (id: number) => post(id, { file: { ext: "webm", size: 99 << 20, url: `${S}/${id}.webm` }, sample: { url: null, alternates: { samples: { "720p": { url: `${S}/${id}_720p.mp4`, size: 5 << 20 } } } } as any });

/** A fake e621 behind a fake scraper: lists (by page), posts and pools; every image has its own bytes. */
function mockSite(o: { fav?: Post[][]; vote?: Post[][]; posts?: Post[]; pools?: Record<number, { category: string; post_ids: number[] }>; auth?: number; favCount?: number } = {}) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const site = async (href: string, headers: HeadersInit = {}) => {
    const url = new URL(href);
    seen.push({ url: url.href, headers: Object.fromEntries(new Headers(headers)) });
    if (url.host === "static1.e621.net") return new Response(`IMG ${url.href}`, { headers: { "Content-Type": url.pathname.endsWith(".mp4") ? "video/mp4" : "image/jpeg" } });
    if (o.auth && !seen.at(-1)!.headers.authorization) return new Response("", { status: o.auth });
    const q = url.searchParams;
    if (url.pathname.startsWith("/users/") && o.favCount !== undefined) return Response.json({ favorite_count: o.favCount });
    if (url.pathname === "/favorites.json") return Response.json({ posts: (o.fav ?? [])[Number(q.get("page") ?? 1) - 1] ?? [] });
    if (url.pathname === "/posts.json" && q.get("tags")!.startsWith("votedup:")) {
      const pages = o.vote ?? [];
      return Response.json({ posts: pages[q.get("page") === "1" ? 0 : pages.findIndex((p) => `b${p.at(-1)!.id}` === q.get("page")) + 1] ?? [] });
    }
    if (url.pathname === "/posts.json") return Response.json({ posts: (o.posts ?? []).filter((p) => p.pools.includes(Number(q.get("tags")!.slice(5)))) });
    const [, kind, id] = url.pathname.match(/^\/(posts|pools)\/(\d+)\.json/) ?? [];
    if (kind === "posts") return Response.json({ post: o.posts!.find((p) => p.id === Number(id)) });
    if (kind === "pools") return Response.json({ id: Number(id), name: "My_Pool", ...o.pools![Number(id)] });
    return new Response("?", { status: 404 });
  };
  /** The scraper's listing of a post or pool link (the file: the original, or the 720p sample of a video). */
  const listing = async ({ url, auth }: { url: string; auth?: string }) => {
    const get = async (path: string) => (await site(`https://e621.net${path}`, auth ? { Authorization: auth } : {})).json<any>();
    const item = (p: Post, data: unknown = p) => ({
      url: p.file.ext === "webm" ? p.sample.alternates!.samples!["720p"].url : p.file.url,
      tags: Object.entries(p.tags).flatMap(([g, t]) => (g === "invalid" ? [] : t)),
      data,
      porn: p.rating === "e",
    });
    const [, kind, id] = new URL(url).pathname.split("/");
    if (kind === "posts") return { site: "e621", source: url, title: null, items: [item((await get(`/posts/${id}.json`)).post)] };
    const { post_ids, ...pool } = await get(`/pools/${id}.json`);
    const { posts } = await get(`/posts.json?tags=pool:${id}`);
    const items = (posts as Post[]).sort((a, b) => post_ids.indexOf(a.id) - post_ids.indexOf(b.id)).map((p) => item(p, { ...p, pool }));
    return { site: "e621", source: url, title: pool.name, items };
  };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const href = String(input);
    if (!href.startsWith(c.SCRAPER_URL)) return site(href, init?.headers);
    const body = JSON.parse(String(init!.body));
    const path = href.slice(c.SCRAPER_URL.length);
    return path === "fetch" ? site(body.url, body.headers) : path === "media" ? site(body.url) : Response.json(await listing(body));
  });
  return { spy, seen };
}

/** The queue: e621 and gallery jobs in order; the rest is kept. */
async function drain() {
  const rest: any[] = [];
  for (let j = jobs.shift(); j; j = jobs.shift()) {
    if (j.type === "e621_sync") await e621Sync(c, j);
    else if (j.type === "gallery") await galleryJob(c, j.importId, j.from);
    else rest.push(j);
  }
  return rest;
}

const account = (id: number) => c.DB.prepare("SELECT * FROM e621_accounts WHERE user_id = ?").bind(id).first<{ error: string | null; backfill_done: number; api_key: string }>();
const memes = (id: number) =>
  c.DB.prepare("SELECT m.kind, m.source, m.source_meta, m.porn, m.status, i.position FROM memes m LEFT JOIN post_items i ON i.meme_id = m.id WHERE m.user_id = ? ORDER BY m.source, i.position")
    .bind(id)
    .all<{ kind: string; source: string; source_meta: string; porn: number; status: string; position: number | null }>()
    .then((r) => r.results);

describe("e621 progress", () => {
  it("shows the favorites of a full scan by pages", async () => {
    await user(390);
    mockSite({ fav: [[post(3901)], []], favCount: 500 });
    await connectE621(c, 390, "ann", "KEY");
    expect(await e621Status(c.DB, 390)).toMatchObject({ fav: null }); // the total comes with the first step
    await e621Sync(c, jobs.shift()); // page 1 is handled
    expect(await e621Status(c.DB, 390)).toMatchObject({ backfill_done: false, fav: { done: 320, total: 500 } });
    await drain();
    expect(await e621Status(c.DB, 390)).toMatchObject({ backfill_done: true, fav: { done: 500, total: 500 } });
    await disconnectE621(c.DB, 390); // the cron of the next tests must not sync it
  });
});

describe("e621 links", () => {
  it("go to the scraper with the user's account and the size limits", async () => {
    expect(gallerySource("https://e621.net/posts/123?q=x")).toBe(scraper);
    expect(gallerySource("https://e621.net/pools/5")).toBe(scraper);
    await user(300);
    mockSite({ fav: [[]] });
    await connectE621(c, 300, "ann", "KEY");
    expect((await account(300))!.api_key).not.toContain("KEY"); // encrypted
    const { spy, seen } = mockSite({ posts: [post(11, { rating: "e" })] });
    const l = await scraper.fetch(c, new URL("https://e621.net/posts/11"), undefined, 300);
    expect(l.items).toMatchObject([{ url: `${S}/data/11.jpg`, porn: true }]);
    const [, init] = spy.mock.calls.find(([u]) => String(u) === c.SCRAPER_URL)!;
    expect(JSON.parse(String(init!.body))).toMatchObject({ url: "https://e621.net/posts/11", auth: `Basic ${btoa("ann:KEY")}`, limits: { photo: 10 << 20, video: 50 << 20 } });
    expect(seen.at(-1)!.headers.authorization).toBe(`Basic ${btoa("ann:KEY")}`);
  });
});

describe("e621 pool button", () => {
  const offers = (spy: ReturnType<typeof mockSite>["spy"]) =>
    spy.mock.calls.filter(([u]) => String(u).endsWith("/sendMessage")).map(([, i]) => JSON.parse(String(i!.body)).reply_markup?.inline_keyboard?.flat().map((b: any) => b.callback_data));

  it("a post of a pool offers the pool, also when the post is already saved; a post without a pool does not", async () => {
    jobs.length = 0; // jobs of the other tests
    await user(330);
    const site = { posts: [post(70, { pools: [9] }), post(71)], pools: { 9: { category: "series", post_ids: [70] } } };
    const { spy } = mockSite(site);
    spy.mockClear();
    await startGallery(c, 330, "https://e621.net/posts/70?q=fav%3Aann", "bot", 330);
    await drain();
    expect(offers(spy)).toEqual([["e621:pool:9"]]);

    await startGallery(c, 330, "https://e621.net/posts/70", "bot", 330);
    await drain();
    expect(offers(spy).at(-1)).toEqual(["e621:pool:9"]); // after "already saved"

    spy.mockClear();
    await startGallery(c, 330, "https://e621.net/posts/71", "bot", 330);
    await drain();
    expect(offers(spy).filter(Boolean)).toEqual([]);
  });
});

describe("e621 sync", () => {
  it("imports favorites and upvotes; a series pool once as a comic; the second sync imports nothing", async () => {
    await user(302);
    const [a, b, d] = [post(10, { pools: [7, 8] }), post(11, { pools: [7] }), post(12, { pools: [7] })];
    const single = post(20, { rating: "e" });
    const video = mp4(40);
    const site = { posts: [a, b, d, single, video], pools: { 7: { category: "series", post_ids: [12, 10, 11] }, 8: { category: "collection", post_ids: [10] } }, fav: [[a, single], []], vote: [[video, single], []] };
    mockSite(site);
    await connectE621(c, 302, "ann", "KEY");
    const rest = await drain();
    expect(rest).toContainEqual({ type: "thumb", memeId: expect.any(String) }); // the video gets its preview first
    const rows = await memes(302);
    expect(rows.map((r) => [r.source, r.position])).toEqual([
      ["https://e621.net/pools/7", 0],
      ["https://e621.net/pools/7", 1],
      ["https://e621.net/pools/7", 2],
      ["https://e621.net/posts/20", 0], // a single meme is a post of its own
      ["https://e621.net/posts/40", 0],
    ]);
    expect(rows[3].porn).toBe(0); // set when described
    expect(JSON.parse(rows[3].source_meta)).toMatchObject({ site: "e621", porn: true, tags: ["tag20", "bob", "wolf"], data: { id: 20, rating: "e" } });
    expect(JSON.parse(rows[0].source_meta).data).toMatchObject({ id: 12, pool: { id: 7 } }); // pool order: 12, 10, 11
    expect(rows[4].kind).toBe("video");
    const acc = await account(302);
    expect(acc).toMatchObject({ error: null, backfill_done: 1 });
    expect((await c.DB.prepare("SELECT COUNT(*) AS n FROM e621_pools WHERE user_id = 302").first<number>("n"))).toBe(1);
    expect((await c.DB.prepare("SELECT COUNT(*) AS n FROM e621_posts WHERE user_id = 302").first<number>("n"))).toBe(5); // 3 pool posts, 20, 40

    // The second sync (cron): nothing new, nothing is downloaded.
    const { seen } = mockSite(site);
    await queueE621(c);
    expect(jobs.filter((j) => j.userId === 302)).toEqual([{ type: "e621_sync", userId: 302, full: false }]);
    await drain();
    expect((await memes(302)).length).toBe(5);
    expect(seen.some((r) => r.url.startsWith(S))).toBe(false);
    expect(seen.some((r) => r.url.includes("/pools/"))).toBe(false);
  });

  it("rating e is porn when the meme is described", async () => {
    await user(303);
    mockSite({ posts: [post(30, { rating: "e" })], fav: [[post(30, { rating: "e" })], []], vote: [[]] });
    await connectE621(c, 303, "ann", "KEY");
    await drain();
    const [row] = await c.DB.prepare("SELECT id FROM memes WHERE user_id = 303").all<{ id: string }>().then((r) => r.results);
    await saveDescription(c.DB, (await getMeme(c.DB, row.id))!, toDescription({ title: "T", porn: false }, ""), "embedding").run();
    expect((await getMeme(c.DB, row.id))!.porn).toBe(1);
  });

  it("a 401 stops the sync with an error; a bad key is not connected", async () => {
    await user(304);
    mockSite({ fav: [[]] });
    await connectE621(c, 304, "ann", "KEY");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 401 }));
    await drain();
    expect(await account(304)).toMatchObject({ error: "unauthorized" });
    jobs.length = 0;
    await queueE621(c);
    expect(jobs.filter((j) => j.userId === 304)).toEqual([]); // stopped until the user connects again

    await expect(connectE621(c, 304, "ann", "BAD")).rejects.toThrow(E621Error); // the site refuses the key
  });
});

describe("e621 sync mode", () => {
  const sources = async (id: number) => (await memes(id)).map((m) => m.source);

  beforeEach(() => void (jobs.length = 0)); // jobs of the other tests

  it("fav scans only favorites, up only upvotes", async () => {
    await user(310);
    await user(311);
    const [a, b] = [post(51), post(52)];
    const site = { posts: [a, b], fav: [[a], []], vote: [[b], []] };
    for (const [id, lists, url, source] of [[310, "fav", "/favorites.json", "posts/51"], [311, "up", "votedup", "posts/52"]] as const) {
      const { seen } = mockSite(site);
      await connectE621(c, id, "ann", "KEY");
      await setE621Lists(c, id, lists);
      await drain();
      expect(await sources(id)).toEqual([`https://e621.net/${source}`]);
      expect(await account(id)).toMatchObject({ backfill_done: 1, lists });
      const lists_ = seen.map((r) => r.url).filter((u) => !u.endsWith("limit=1") && (u.includes("/favorites.json") || u.includes("votedup")));
      expect(lists_.length).toBeGreaterThan(0);
      expect(lists_.every((u) => u.includes(url))).toBe(true);
      // the quick scan goes over the chosen list only
      await queueE621(c);
      mockSite(site);
      await drain();
    }
  });

  it("with pools off a post of a series pool is saved alone", async () => {
    await user(313);
    const site = { posts: [post(81, { pools: [17] })], pools: { 17: { category: "series", post_ids: [81, 82] } }, fav: [[post(81, { pools: [17] })], []], vote: [[]] };
    mockSite(site);
    await connectE621(c, 313, "ann", "KEY");
    await setE621Pools(c.DB, 313, false);
    expect(await e621Status(c.DB, 313)).toMatchObject({ pools: false });
    await drain();
    expect((await memes(313)).map((m) => m.source)).toEqual(["https://e621.net/posts/81"]);
    expect(await c.DB.prepare("SELECT COUNT(*) AS n FROM e621_pools WHERE user_id = 313").first<number>("n")).toBe(0);
  });

  it("switching to both backfills the list that was not synced", async () => {
    await user(312);
    const [a, b] = [post(61), post(62)];
    const site = { posts: [a, b], fav: [[a], []], vote: [[b], []] };
    mockSite(site);
    await connectE621(c, 312, "ann", "KEY");
    await setE621Lists(c, 312, "fav");
    await drain();
    expect(await memes(312)).toHaveLength(1);

    const { seen } = mockSite(site);
    await setE621Lists(c, 312, "both");
    expect(jobs).toContainEqual({ type: "e621_sync", userId: 312, full: true });
    await drain();
    expect(await memes(312)).toHaveLength(2);
    expect(await account(312)).toMatchObject({ backfill_done: 1, lists: "both" });
    expect(seen.some((r) => r.url.includes("/favorites.json"))).toBe(false); // favorites are done already
  });
});

describe("/e621 bot command", () => {
  let calls: { method: string; body: any }[] = [];
  const setup = (o: Parameters<typeof mockSite>[0] = {}, bad = false) => {
    calls = [];
    const { spy } = mockSite(o);
    const site = spy.getMockImplementation()!;
    spy.mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes("api.telegram.org")) return bad ? new Response("", { status: 401 }) : site(input, init);
      const method = url.split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ method, body });
      if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "b", username: "memebot" } });
      return Response.json({ ok: true, result: { message_id: 7, date: 0, chat: { id: body.chat_id, type: "private" }, text: "x" } });
    });
  };
  const chat = (id: number) => ({ id, type: "private" as const });
  const from = (id: number) => ({ id, is_bot: false, first_name: `N${id}` });
  const say = (id: number, text: string) => ({ update_id: 1, message: { message_id: 5, date: 0, chat: chat(id), from: from(id), text, entities: [{ type: "bot_command", offset: 0, length: 5 }] } });
  const tap = (id: number, data: string) => ({ update_id: 1, callback_query: { id: "q", chat_instance: "i", data, from: from(id), message: { message_id: 5, date: 0, chat: chat(id), text: "x" } } });

  it("connects: the message with the key is deleted; a bad key is refused", async () => {
    await user(320);
    setup({}, true);
    const bot = createBot(c);
    await bot.init();
    await bot.handleUpdate(say(320, "/e621") as any);
    expect(calls.find((x) => x.method === "sendMessage")!.body.text).toContain("Manage API Access");

    calls = [];
    await bot.handleUpdate(say(320, "/e621 ann BAD") as any);
    expect(calls.map((x) => x.method)).toEqual(["deleteMessage", "sendMessage"]);
    expect(calls[1].body.text).toContain("refused");
    expect(await account(320)).toBeNull();

    setup({ fav: [[]], vote: [[]] });
    await bot.handleUpdate(say(320, "/e621 ann KEY") as any);
    expect(calls[0]).toMatchObject({ method: "deleteMessage", body: { chat_id: 320, message_id: 5 } });
    expect(calls.at(-1)!.body.text).toContain("ann");
    expect(await account(320)).toMatchObject({ lists: "both" });
    expect(jobs).toContainEqual({ type: "e621_sync", userId: 320, full: true });
  });

  it("buttons: mode, disconnect", async () => {
    await user(321);
    setup({ fav: [[]], vote: [[]] });
    await connectE621(c, 321, "ann", "KEY");
    const bot = createBot(c);
    await bot.init();
    await bot.handleUpdate(say(321, "/e621") as any);
    const marked = (kb: any) => kb.inline_keyboard[0].filter((b: any) => b.icon_custom_emoji_id).map((b: any) => b.callback_data);
    expect(marked(calls.find((x) => x.method === "sendMessage")!.body.reply_markup)).toEqual(["e621:lists:both"]);

    calls = [];
    await bot.handleUpdate(tap(321, "e621:lists:up") as any);
    expect(await c.DB.prepare("SELECT lists FROM e621_accounts WHERE user_id = 321").first<string>("lists")).toBe("up");
    expect(marked(calls.find((x) => x.method === "editMessageText")!.body.reply_markup)).toEqual(["e621:lists:up"]);

    jobs.length = 0;
    await bot.handleUpdate(tap(321, "e621:pool:9") as any);
    expect(calls.map((x) => x.method)).toContain("answerCallbackQuery");
    expect(jobs).toContainEqual({ type: "gallery", importId: expect.any(String), from: 0 }); // the pool import

    await bot.handleUpdate(tap(321, "e621:off") as any);
    expect(await account(321)).toBeNull();
    expect(calls.at(-1)!.body.text).toContain("disconnected");
  });
});
