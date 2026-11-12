import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connectE621, e621Sync, queueE621 } from "../src/e621";
import type { Env } from "../src/env";
import { saveDescription, toDescription } from "../src/ingest/describe";
import { galleryJob, gallerySource } from "../src/ingest/gallery";
import { e621, E621Error, mediaUrl, rate, type Post } from "../src/ingest/sources/e621";
import { getMeme } from "../src/db";

beforeAll(() => void (rate.gap = 0));
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

/** A fake e621: lists (by page), posts and pools; every image has its own bytes. */
function mockSite(o: { fav?: Post[][]; vote?: Post[][]; posts?: Post[]; pools?: Record<number, { category: string; post_ids: number[] }>; auth?: number } = {}) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    seen.push({ url: url.href, headers: Object.fromEntries(new Headers(init?.headers)) });
    if (url.host === "static1.e621.net") return new Response(`IMG ${url.href}`, { headers: { "Content-Type": url.pathname.endsWith(".mp4") ? "video/mp4" : "image/jpeg" } });
    if (o.auth && !seen.at(-1)!.headers.authorization) return new Response("", { status: o.auth });
    const q = url.searchParams;
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

describe("e621 media", () => {
  it("picks the file", () => {
    expect(mediaUrl(post(1))).toBe(`${S}/data/1.jpg`);
    expect(mediaUrl(post(2, { file: { ext: "png", size: 20 << 20, url: `${S}/data/2.png` } }))).toBe(`${S}/sample/2.jpg`); // too big for a photo
    expect(mediaUrl(post(3, { file: { ext: "jpg", size: 1000, url: null } , sample: { url: null } }))).toBeNull(); // hidden from guests
    expect(mediaUrl(mp4(4))).toBe(`${S}/4_720p.mp4`);
    expect(mediaUrl(post(5, { file: { ext: "webm", size: 1000, url: `${S}/5.webm` } }))).toBeNull(); // webm without an mp4
    expect(mediaUrl(post(6, { file: { ext: "mp4", size: 1000, url: `${S}/6.mp4` } }))).toBe(`${S}/6.mp4`);
    expect(mediaUrl(post(7, { file: { ext: "swf", size: 1000, url: `${S}/7.swf` } }))).toBeNull();
    expect(mediaUrl(post(8, { file: { ext: "gif", size: 20 << 20, url: `${S}/8.gif` } }))).toBe(`${S}/8.gif`); // GIFs may be up to 50 MB
  });
});

describe("e621 links", () => {
  it("matches posts and pools", () => {
    expect(gallerySource("https://e621.net/posts/123?q=x")).toBe(e621);
    expect(gallerySource("https://e621.net/pools/5")).toBe(e621);
    expect(gallerySource("https://e621.net/posts")).toBeFalsy();
  });

  it("a post: full data, all tag groups except invalid, rating e is porn; the account and a generic User-Agent are sent", async () => {
    await user(300);
    const p = post(11, { rating: "e", tags: { artist: ["bob"], character: ["Fox"], general: ["tag"], invalid: ["bad"], lore: ["l"], meta: ["m"], species: ["wolf"], copyright: ["c"] } });
    mockSite({ posts: [p], fav: [[]] });
    await connectE621(c, 300, "ann", "KEY");
    const { seen } = mockSite({ posts: [p] });
    const l = await e621.fetch(c, new URL("https://e621.net/posts/11"), undefined, 300);
    expect(seen[0].headers.authorization).toBe(`Basic ${btoa("ann:KEY")}`);
    expect(seen[0].headers["user-agent"]).toBe("memesave/1.0 (e621 importer)");
    expect(l.source).toBe("https://e621.net/posts/11");
    expect(l.items).toEqual([{ url: `${S}/data/11.jpg`, tags: ["bob", "Fox", "tag", "l", "m", "wolf", "c"], data: p, porn: true }]);
    expect((await account(300))!.api_key).not.toContain("KEY"); // encrypted
    mockSite({ posts: [p] });
    expect((await e621.fetch(c, new URL("https://e621.net/posts/11"))).items.length).toBe(1);
  });

  it("a pool is a comic in pool order with the pool in every page's data", async () => {
    await user(301);
    const posts = [post(1, { pools: [9] }), post(2, { pools: [9] }), post(3, { pools: [9] })];
    mockSite({ posts: [...posts].reverse(), pools: { 9: { category: "series", post_ids: [2, 3, 1] } } });
    const l = await e621.fetch(c, new URL("https://e621.net/pools/9"));
    expect(l.title).toBe("My Pool");
    expect(l.source).toBe("https://e621.net/pools/9");
    expect(l.items.map((i) => "url" in i && i.url)).toEqual([`${S}/data/2.jpg`, `${S}/data/3.jpg`, `${S}/data/1.jpg`]);
    expect((l.items[0].data as any).pool).toMatchObject({ id: 9, name: "My_Pool", category: "series" });
    expect((l.items[0].data as any).pool.post_ids).toBeUndefined();
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
