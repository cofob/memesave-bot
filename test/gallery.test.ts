import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { getMeme } from "../src/db";
import { describeRequest, saveDescription, toDescription } from "../src/ingest/describe";
import { galleryJob, gallerySource, startGallery } from "../src/ingest/gallery";
import { telegraph } from "../src/ingest/sources/telegraph";

afterEach(() => vi.restoreAllMocks());

const jobs: any[] = [];
const c = { ...env, JOBS: { send: async (b: unknown) => void jobs.push(b) } } as unknown as Env;
const user = async (id: number) => void (await c.DB.prepare("INSERT INTO users (id, role, lang) VALUES (?, 'user', 'en')").bind(id).run());

/** Telegraph answers with `n` images (one of them in a figure, one with a relative URL); the images are all different. */
function mockSite(n: number, telegram: string[] = []) {
  const img = (i: number) => (i === 1 ? { tag: "figure", children: [{ tag: "img", attrs: { src: `/file/p${i}.jpg` } }, { tag: "figcaption", children: ["x"] }] } : { tag: "img", attrs: { src: `https://img.test/p${i}.jpg` } });
  const page = { ok: true, result: { title: "My Comic", author_name: "Ann", author_url: "https://t.me/ann", description: "d", content: [{ tag: "p", children: ["text"] }, ...Array.from({ length: n }, (_, i) => img(i))] } };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://api.telegra.ph/getPage/")) return Response.json(page);
    if (url.includes("api.telegram.org")) return telegram.push(url), Response.json({ ok: true, result: {} });
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

describe("telegraph", () => {
  it("matches its links and reads the title, images in order and metadata", async () => {
    expect(gallerySource("https://telegra.ph/My-Comic-01-01")).toBe(telegraph);
    expect(gallerySource("https://graph.org/x")).toBe(telegraph);
    expect(gallerySource("https://telegra.ph/")).toBeFalsy();
    expect(gallerySource("https://example.com/x")).toBeFalsy();
    expect(gallerySource("not a url")).toBeFalsy();
    mockSite(3);
    const l = await telegraph.fetch(c, new URL("https://telegra.ph/My-Comic-01-01/"));
    expect(l.source).toBe("https://telegra.ph/My-Comic-01-01");
    expect(l.title).toBe("My Comic");
    expect(l.items.map((i) => ("url" in i ? i.url : ""))).toEqual(["https://img.test/p0.jpg", "https://telegra.ph/file/p1.jpg", "https://img.test/p2.jpg"]);
    expect(l.data).toEqual({ title: "My Comic", author_name: "Ann", author_url: "https://t.me/ann", description: "d" });
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
    expect(telegram.map((u) => u.split("/").pop())).toEqual(["sendMessage", "sendMessage"]); // saving, saved
    expect(jobs.length).toBe(0);
    expect((await c.MEDIA.list({ prefix: "tmp/gallery/" })).objects).toEqual([]); // the state is deleted

    await startGallery(c, 90, "https://telegra.ph/My-Comic-01-01", "bot", 90);
    expect(await drain()).toBe(1);
    expect((await all(90)).length).toBe(12);
    expect(telegram.length).toBe(3); // already saved
    expect((await c.MEDIA.list({ prefix: "tmp/gallery/" })).objects).toEqual([]);
  });

  it("skips GIFs and a failed page in a comic; one image is a normal meme", async () => {
    await user(91);
    const spy = mockSite(3);
    const site = spy.getMockImplementation()!;
    spy.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/p1.jpg") || url.includes("/file/p1.jpg")) return new Response("X", { headers: { "Content-Type": "image/gif" } });
      if (url.endsWith("/p2.jpg")) return new Response("no", { status: 404 });
      return site(input, init);
    });
    await startGallery(c, 91, "https://telegra.ph/My-Comic-01-01", "web");
    await drain();
    expect((await all(91)).map((r) => r.position)).toEqual([0]); // only page 1 is saved

    await user(92);
    mockSite(1);
    await startGallery(c, 92, "https://telegra.ph/My-Comic-01-01", "web");
    await drain();
    const [one] = await all(92);
    expect(one.layout).toBe("carousel");
    expect(one.media_group_id).toBeNull();
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
