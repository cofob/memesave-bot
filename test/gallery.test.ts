import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { getMeme } from "../src/db";
import { describeRequest, saveDescription, toDescription } from "../src/ingest/describe";
import { galleryJob, gallerySource, pageRanges, startGallery } from "../src/ingest/gallery";
import { scraper } from "../src/ingest/scraper";

afterEach(() => vi.restoreAllMocks());

const jobs: any[] = [];
const delays: (number | undefined)[] = []; // delaySeconds of every gallery job sent
const c = { ...env, JOBS: { send: async (b: unknown, o?: { delaySeconds?: number }) => void (jobs.push(b), (b as { type: string }).type === "gallery" && delays.push(o?.delaySeconds)) } } as unknown as Env;
const user = async (id: number) => void (await c.DB.prepare("INSERT INTO users (id, role, lang) VALUES (?, 'user', 'en')").bind(id).run());

/** The scraper lists a Telegraph page of `n` images and downloads them from the site (`fetch` of the item URL); the images are all different. */
function mockSite(n: number, telegram: string[] = []) {
  const listing = {
    site: "telegraph",
    source: "https://telegra.ph/My-Comic-01-01",
    title: "My Comic",
    data: { title: "My Comic", author_name: "Ann", author_url: "https://t.me/ann", description: "d" },
    items: Array.from({ length: n }, (_, i) => ({ url: i === 1 ? "https://telegra.ph/file/p1.jpg" : `https://img.test/p${i}.jpg` })),
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === c.SCRAPER_URL) return Response.json(listing);
    if (url === `${c.SCRAPER_URL}media`) return fetch(JSON.parse(String(init!.body)).url); // the scraper downloads the item from the site
    if (url.includes("api.telegram.org")) return telegram.push(url), Response.json({ ok: true, result: { message_id: 7 } });
    return new Response(`IMG ${url}`, { headers: { "Content-Type": "image/jpeg" } });
  });
}

/** Runs the queue: every gallery job in order (what the queue consumer does). */
async function drain() {
  let n = 0;
  for (let j = jobs.shift(); j; j = jobs.shift()) {
    if (j.type === "gallery") (n++, await galleryJob(c, j.importId, j.from));
  }
  return n;
}

describe("gallery sites", () => {
  it("are listed by the scraper; its errors keep the status of the site", async () => {
    for (const u of ["https://telegra.ph/My-Comic-01-01", "https://graph.org/x", "https://nhentai.net/g/1/", "https://comics.8muses.com/porn/album/A", "https://kemono.su/patreon/user/1", "https://xlecx.one/55945-the-magic-wands.html", "https://yiffer.xyz/Some%20Comic", "https://tailspace.com/c/Some%20Comic", "https://rule34.xxx/index.php?page=post&s=view&id=1", "https://www.gelbooru.com/index.php?page=pool&s=show&id=1", "https://danbooru.donmai.us/posts/1", "https://www.furaffinity.net/view/1/", "https://www.pixiv.net/en/artworks/1"]) expect(gallerySource(u)).toBe(scraper);
    expect(gallerySource("https://example.com/x")).toBeFalsy();
    expect(gallerySource("not a url")).toBeFalsy();
    const spy = mockSite(3);
    const l = await scraper.fetch(c, new URL("https://telegra.ph/My-Comic-01-01/"), "5");
    expect(l.items.map((i) => ("url" in i ? i.url : ""))).toEqual(["https://img.test/p0.jpg", "https://telegra.ph/file/p1.jpg", "https://img.test/p2.jpg"]);
    const [, init] = spy.mock.calls[0];
    expect(new Headers(init!.headers).get("Authorization")).toBe(`Api-Key ${c.SCRAPER_API_KEY}`);
    expect(JSON.parse(String(init!.body))).toMatchObject({ url: "https://telegra.ph/My-Comic-01-01/", cursor: "5" });

    spy.mockImplementation(async () => Response.json({ error: { code: "upstream", status: 429 } }, { status: 502 }));
    await expect(scraper.fetch(c, new URL("https://nhentai.net/g/1/"))).rejects.toThrow("429"); // the queue backs off
    const res = await scraper.download(c, { page: "https://e-hentai.org/s/a/1-1" }, "e-hentai");
    expect(res.status).toBe(429);
    expect(JSON.parse(String(spy.mock.calls.at(-1)![1]!.body))).toEqual({ site: "e-hentai", page: "https://e-hentai.org/s/a/1-1" });
  });
});

describe("gallery import", () => {
  const all = (id: number) =>
    c.DB.prepare(
      `SELECT m.id, m.caption, m.source, m.source_meta, p.layout, p.media_group_id, i.position FROM memes m
       JOIN post_items i ON i.meme_id = m.id JOIN posts p ON p.id = i.post_id WHERE m.user_id = ? ORDER BY i.position`,
    )
      .bind(id)
      .all<{ id: string; caption: string | null; source: string; source_meta: string; layout: string; media_group_id: string | null; position: number }>()
      .then((r) => r.results);

  it("saves 12 images over jobs as one comic, notifies and dedupes", async () => {
    await user(90);
    const telegram: string[] = [];
    mockSite(12, telegram);
    await startGallery(c, 90, "https://telegra.ph/My-Comic-01-01", "bot", 90);
    expect(await drain()).toBe(3); // listing, images 1-10, images 11-12 (the page list is read once)
    const rows = await all(90);
    expect(rows.map((r) => r.position)).toEqual([...Array(12).keys()]);
    expect(new Set(rows.map((r) => r.media_group_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.layout))).toEqual(new Set(["comic"]));
    expect(rows.map((r) => r.caption)).toEqual(["My Comic", ...Array(11).fill(null)]);
    expect(rows[3].source).toBe("https://telegra.ph/My-Comic-01-01");
    expect(JSON.parse(rows[3].source_meta)).toMatchObject({ site: "telegraph", tags: [], data: { author_name: "Ann" } });
    expect(telegram.map((u) => u.split("/").pop())).toEqual(["sendWidget", "editMessageWidgetData"]); // the progress widget (more than a chunk), its final state
    expect(jobs.length).toBe(0);
    expect((await c.MEDIA.list({ prefix: "tmp/gallery/" })).objects).toEqual([]); // the state is deleted

    await startGallery(c, 90, "https://telegra.ph/My-Comic-01-01", "bot", 90);
    expect(await drain()).toBe(1);
    expect((await all(90)).length).toBe(12);
    expect(telegram.length).toBe(3); // already saved (text)
    expect((await c.MEDIA.list({ prefix: "tmp/gallery/" })).objects).toEqual([]);
  });

  it("shows the progress of a big comic in a widget, with the texts only when Telegram refuses it", async () => {
    await user(94);
    const telegram: string[] = [];
    const spy = mockSite(25, telegram);
    await startGallery(c, 94, "https://telegra.ph/My-Comic-01-01", "bot", 94);
    expect(await drain()).toBe(4); // listing, 3 chunks
    expect(telegram.map((u) => u.split("/").pop())).toEqual(["sendWidget", "editMessageWidgetData"]); // the edits in between are throttled
    const edit = spy.mock.calls.find(([u]) => String(u).endsWith("editMessageWidgetData"))![1]!;
    expect(JSON.parse(JSON.parse(String(edit.body)).chat_data)).toEqual({ f: 25, t: 25, d: 25, k: 0, e: 1 });

    await user(95);
    const refused: string[] = [];
    const site = mockSite(25, refused).getMockImplementation()!;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => (String(input).endsWith("/sendWidget") ? (refused.push("sendWidget"), Response.json({ ok: false, error_code: 400, description: "no" }, { status: 400 })) : site(input, init)));
    await startGallery(c, 95, "https://telegra.ph/My-Comic-01-01", "bot", 95);
    await drain();
    expect(refused.map((u) => u.split("/").pop())).toEqual(["sendWidget", "sendMessage", "sendMessage"]); // saving, saved
    expect((await all(95)).length).toBe(25);
  });

  it("keeps GIF and video pages in a comic, skips a failed page; one image is a normal meme", async () => {
    await user(91);
    const spy = mockSite(4);
    const site = spy.getMockImplementation()!;
    spy.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/p1.jpg") || url.includes("/file/p1.jpg")) return new Response("X", { headers: { "Content-Type": "image/gif" } });
      if (url.endsWith("/p2.jpg")) return new Response("V", { headers: { "Content-Type": "video/mp4" } });
      if (url.endsWith("/p3.jpg")) return new Response("no", { status: 404 });
      return site(input, init);
    });
    const send = vi.spyOn(c.JOBS, "send");
    await startGallery(c, 91, "https://telegra.ph/My-Comic-01-01", "web");
    await drain();
    const rows = await all(91);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    const kinds = await c.DB.prepare("SELECT kind FROM memes WHERE user_id = 91 ORDER BY kind").all<{ kind: string }>();
    expect(kinds.results.map((k) => k.kind)).toEqual(["animation", "photo", "video"]);
    const jobOf = (id: string) => send.mock.calls.map(([b]) => b as { type: string; memeId?: string }).find((b) => b.memeId === id)?.type;
    expect(rows.map((r) => jobOf(r.id))).toEqual(["embed", "thumb", "thumb"]); // GIF and video get an ffmpeg preview first

    await user(92);
    mockSite(1);
    await startGallery(c, 92, "https://telegra.ph/My-Comic-01-01", "web");
    await drain();
    const [one] = await all(92);
    expect(one.layout).toBe("carousel");
    expect(one.media_group_id).toBeNull();
  });
});

describe("gallery retries and the report of missing pages", () => {
  /** Telegraph site (3 pages) where `fail` answers the requests of a page; returns the bot messages. */
  function setup(fail: (url: string) => Response | Promise<Response> | undefined) {
    const spy = mockSite(3);
    const site = spy.getMockImplementation()!;
    spy.mockImplementation(async (input, init) => (String(input).includes("/p") && (await fail(String(input)))) || site(input, init));
    return () => spy.mock.calls.filter(([u]) => String(u).endsWith("/sendMessage")).map(([, i]) => JSON.parse(String(i!.body)).text as string);
  }
  const pages = (id: number) => c.DB.prepare("SELECT i.position FROM post_items i JOIN memes m ON m.id = i.meme_id WHERE m.user_id = ? ORDER BY i.position").bind(id).all<{ position: number }>().then((r) => r.results.map((x) => x.position));
  const run = async (id: number) => {
    delays.length = 0;
    await startGallery(c, id, "https://telegra.ph/My-Comic-01-01", "bot", id);
    await drain();
  };

  it("saves a page that failed twice with 503 at its own position after retry jobs", async () => {
    await user(96);
    let n = 0;
    const texts = setup((url) => (url.endsWith("/p2.jpg") && n++ < 4 ? new Response("busy", { status: 503 }) : undefined)); // 2 passes: direct, then the scraper
    await run(96);
    expect(await pages(96)).toEqual([0, 1, 2]);
    expect(delays).toEqual([undefined, undefined, 60, 300]); // listing, chunk, two retry passes
    expect(texts().length).toBe(2); // saving, saved: no report
    expect(texts()[1]).toContain("saved: 3 pages");
  });

  it("reports a page that always fails with a network error after 3 retries", async () => {
    await user(97);
    const texts = setup((url) => {
      if (url.includes("/file/p1.jpg")) throw new TypeError("network");
    });
    await run(97);
    expect(await pages(97)).toEqual([0, 2]);
    expect(delays).toEqual([undefined, undefined, 60, 300, 900]);
    expect(texts()[1]).toContain("saved 2 of 3 pages");
    expect(texts()[1]).toContain("Download error: 2");
  });

  it("reports a 404 and keeps a GIF page", async () => {
    await user(98);
    const texts = setup((url) => (url.includes("/file/p1.jpg") ? new Response("X", { headers: { "Content-Type": "image/gif" } }) : url.endsWith("/p2.jpg") ? new Response("no", { status: 404 }) : undefined));
    await run(98);
    expect(await pages(98)).toEqual([0, 1]); // the GIF is kept
    expect(delays).toEqual([undefined, undefined]); // no retries
    expect(texts()[1]).toContain("saved 2 of 3 pages");
    expect(texts()[1]).toContain("Download error: 3");
    expect(texts()[1]).not.toContain("Not an image");
  });

  it("moves the rest of a slow chunk to the next job, so the queue serves other jobs", async () => {
    await user(99);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    setup(() => void (now += 31_000)); // every page takes 31 s
    jobs.length = 0;
    await startGallery(c, 99, "https://telegra.ph/My-Comic-01-01", "bot", 99);
    expect(await drain()).toBe(3); // listing, pages 1-2 (62 s), page 3
    expect(await pages(99)).toEqual([0, 1, 2]);
  });

  it("joins page numbers into ranges", () => {
    expect(pageRanges([5, 17, 18, 19])).toBe("5, 17–19");
    expect(pageRanges(Array.from({ length: 60 }, (_, i) => i * 2 + 1)).endsWith(", …")).toBe(true);
  });
});

describe("source metadata", () => {
  it("is described with the source context, its tags are merged and its porn flag is kept", async () => {
    await user(93);
    await c.DB.prepare(
      `INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, source_meta) VALUES ('sm1', 93, 'photo', 'f', 'sm1', 'describing', ?)`,
    )
      .bind(JSON.stringify({ site: "e621", tags: ["Wolf", "female"], porn: true, data: { rating: "e", artist: ["Bob"] } }))
      .run();
    const m = (await getMeme(c.DB, "sm1"))!;
    const text = JSON.stringify(describeRequest(m, [], []).messages[1].content);
    expect(text).toContain("Source metadata (e621): tags: Wolf, female;");
    expect(text).toContain("Bob");

    await saveDescription(c.DB, m, toDescription({ title: "T", tags: ["Female", "cute"], porn: false }, "")).run();
    const saved = (await getMeme(c.DB, "sm1"))!;
    expect(saved.tags!.split("\n")).toEqual(["female", "cute", "wolf"]);
    expect(saved.porn).toBe(1);
  });
});
