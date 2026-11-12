import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GallerySource, Item } from "../src/ingest/gallery";
import { gallerySource } from "../src/ingest/gallery";
import { allporncomic } from "../src/ingest/sources/allporncomic";
import { asmhentai } from "../src/ingest/sources/asmhentai";
import { ehentai } from "../src/ingest/sources/ehentai";
import { hentaifox } from "../src/ingest/sources/hentaifox";
import { hitomi } from "../src/ingest/sources/hitomi";
import { imhentai } from "../src/ingest/sources/imhentai";
import { kemono } from "../src/ingest/sources/kemono";
import { multporn } from "../src/ingest/sources/multporn";
import { muses } from "../src/ingest/sources/muses";
import { nhentai } from "../src/ingest/sources/nhentai";
import { imgSrc, linkTags, numbered, scrape } from "../src/ingest/sources/html";

afterEach(() => vi.restoreAllMocks());

type Route = string | object | ((req: { url: string; init?: RequestInit }) => string | object);
const calls: { url: string; init?: RequestInit }[] = [];

/** The site answers from the routes (exact URL; a string is a body, an object is JSON); anything else is 404. */
function site(routes: Record<string, Route>) {
  calls.length = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const r = routes[url];
    if (r === undefined) return new Response("not found", { status: 404 });
    const body = typeof r === "function" ? r({ url, init }) : r;
    return typeof body === "string" ? new Response(body, { headers: { "Content-Type": "text/html" } }) : Response.json(body);
  });
}

const run = (src: GallerySource, url: string, cursor?: string) => src.fetch(env, new URL(url), cursor);
const urls = (items: Item[]) => items.map((i) => ("url" in i ? i.url : i.page));

describe("html helpers", () => {
  it("scrapes elements in document order with text and entities", async () => {
    const hits = await scrape(`<h1>A &amp; <b>B</b> &#39;x&#39;</h1><a href="/x">1</a><h1>C</h1>`, "h1", "a");
    expect(hits.map((h) => [h.sel, h.text])).toEqual([["h1", "A & B 'x'"], ["a", "1"], ["h1", "C"]]);
    expect(hits[1].attrs.href).toBe("/x");
  });
  it("takes the image attribute in the Hentoid order and resolves the URL", () => {
    expect(imgSrc({ src: "data:x", "data-src": " //cdn.test/a.jpg " }, "https://x.test/p")).toBe("https://cdn.test/a.jpg");
    expect(imgSrc({ "data-original": "/b.png" }, "https://x.test/p")).toBe("https://x.test/b.png");
    expect(imgSrc({}, "https://x.test/")).toBe("");
  });
  it("forges the page URLs from the format map", () => {
    expect(numbered("https://i.test/001/1/", { "1": "j,1,1", "2": "p,1,1", "3": "g,1,1", "4": "w,1,1" })).toEqual(["https://i.test/001/1/1.jpg", "https://i.test/001/1/2.png", "https://i.test/001/1/3.gif", "https://i.test/001/1/4.webp"]);
  });
  it("makes tags of the links by their type", async () => {
    const links = await scrape(`<a href="/artist/koari/">k</a><a href="/tag/sole-male/">s</a><a href="/tag/sole-male/">s</a><a href="/other/x/">o</a>`, "a");
    expect(linkTags(links)).toEqual({ tags: ["koari", "sole_male"], groups: { artists: ["koari"], tags: ["sole_male", "sole_male"] } });
  });
});

describe("source matching", () => {
  it("finds the source of every site link", () => {
    const of = (u: string) => gallerySource(u);
    expect(of("https://nhentai.net/g/177013/")).toBe(nhentai);
    expect(of("https://e-hentai.org/g/618395/0439fa3666/")).toBe(ehentai);
    expect(of("https://hitomi.la/doujinshi/some-title-english-1000.html#1")).toBe(hitomi);
    expect(of("https://hitomi.la/reader/1000.html")).toBe(hitomi);
    expect(of("https://imhentai.xxx/gallery/1/")).toBe(imhentai);
    expect(of("https://hentaifox.com/gallery/1/")).toBe(hentaifox);
    expect(of("https://asmhentai.com/g/1/")).toBe(asmhentai);
    expect(of("https://www.8muses.com/comics/album/A/B")).toBe(muses);
    expect(of("https://comics.8muses.com/porn/album/A/B")).toBe(muses);
    expect(of("https://multporn.net/comics/adult_time_mini")).toBe(multporn);
    expect(of("https://allporncomic.com/porncomic/10-am/")).toBe(allporncomic);
    expect(of("https://allporncomic.com/porncomic/10-am/1-10-am/")).toBe(allporncomic);
    expect(of("https://kemono.su/patreon/user/1/post/2")).toBe(kemono);
    expect(of("https://kemono.cr/patreon/user/1")).toBe(kemono);
    expect(of("https://nhentai.net/")).toBeFalsy();
    expect(of("https://e-hentai.org/")).toBeFalsy();
    expect(of("https://kemono.cr/patreon")).toBeFalsy();
  });
});

describe("nhentai", () => {
  const gallery = {
    id: 696313,
    media_id: "4321238",
    title: { english: "[Circle] Long Title [Digital]", japanese: "日本語", pretty: "Short Title" },
    scanlator: "",
    upload_date: 1794492841,
    num_pages: 2,
    num_favorites: 55,
    tags: [
      { type: "category", name: "doujinshi" },
      { type: "language", name: "japanese" },
      { type: "artist", name: "fuetakishi" },
      { type: "group", name: "shoot the moon" },
      { type: "parody", name: "original" },
      { type: "character", name: "some girl" },
      { type: "tag", name: "sole female" },
    ],
    pages: [{ number: 1, path: "galleries/4321238/1.webp" }, { number: 2, path: "galleries/4321238/2.jpg" }],
  };
  it("lists the pages from the API with all tags and data", async () => {
    site({ "https://nhentai.net/api/v2/galleries/696313": gallery });
    const l = await run(nhentai, "https://nhentai.net/g/696313/2/");
    expect(l.source).toBe("https://nhentai.net/g/696313/");
    expect(l.title).toBe("Short Title");
    expect(urls(l.items)).toEqual(["https://i1.nhentai.net/galleries/4321238/1.webp", "https://i1.nhentai.net/galleries/4321238/2.jpg"]);
    expect(l.tags).toEqual(["doujinshi", "japanese", "fuetakishi", "shoot_the_moon", "original", "some_girl", "sole_female"]);
    expect(l.data).toMatchObject({ id: 696313, artists: ["fuetakishi"], groups: ["shoot_the_moon"], parodies: ["original"], characters: ["some_girl"], languages: ["japanese"], categories: ["doujinshi"], tags: ["sole_female"], pages: 2, favorites: 55, uploaded: "2026-11-12T14:14:01.000Z" });
    expect(l.next).toBeUndefined();
  });
  it("fails on a missing gallery", async () => {
    site({});
    await expect(run(nhentai, "https://nhentai.net/g/1/")).rejects.toThrow("404");
  });
});

describe("e-hentai", () => {
  const meta = {
    gid: 618395,
    token: "0439fa3666",
    title: "(Kouroumu 8) [Handful Happiness!] TOUHOU GUNMANIA A2",
    title_jpn: "東方",
    category: "Non-H",
    uploader: "ave",
    posted: "1376110208",
    filecount: "25",
    filesize: 51210504,
    rating: "4.55",
    tags: ["language:japanese", "parody:touhou project", "character:hong meiling", "group:handful happiness", "artist:nanahara fuyuki", "other:full color", "female:full color"],
  };
  const base = "https://e-hentai.org/g/618395/0439fa3666/";
  const listing = (p: number, total = 25) =>
    `<table class="ptt"><tr><td class="ptdd">&lt;</td>${Array.from({ length: total }, (_, i) => `<td><a href="${base}?p=${i}">${i + 1}</a></td>`).join("")}<td><a href="${base}?p=1">&gt;</a></td></tr></table>` +
    `<div id="gdt" class="gt200"><a href="https://e-hentai.org/s/h${p}/618395-${p + 1}"><div title="Page ${p + 1}"></div></a></div>`;
  const routes = () => ({
    "https://api.e-hentai.org/api.php": { gmetadata: [meta] },
    ...Object.fromEntries(Array.from({ length: 25 }, (_, p) => [`${base}?p=${p}`, listing(p)])),
  });

  it("reads the metadata and the first 19 listing pages, then gives a cursor", async () => {
    site(routes());
    const l = await run(ehentai, "https://e-hentai.org/g/618395/0439fa3666/");
    expect(l.source).toBe(base);
    expect(l.title).toBe(meta.title);
    expect(l.tags).toEqual(["japanese", "touhou_project", "hong_meiling", "handful_happiness", "nanahara_fuyuki", "full_color", "non-h"]);
    expect(l.data).toMatchObject({ gid: 618395, title_jpn: "東方", category: "Non-H", uploader: "ave", filecount: "25", pages: 25, rating: "4.55" });
    expect(l.items).toHaveLength(19);
    expect(l.items[0]).toEqual({ page: "https://e-hentai.org/s/h0/618395-1" });
    expect(l.next).toBe("19");
    const gdata = calls.find((c) => c.url.includes("api.php"))!;
    expect(JSON.parse(gdata.init!.body as string)).toEqual({ method: "gdata", gidlist: [[618395, "0439fa3666"]], namespace: 1 });
    expect(new Headers(calls[1].init?.headers).get("Cookie")).toBe("nw=1");
  });

  it("continues from the cursor without asking the metadata again", async () => {
    site(routes());
    const l = await run(ehentai, "https://e-hentai.org/g/618395/0439fa3666/", "19");
    expect(l.title).toBeNull();
    expect(l.data).toBeUndefined();
    expect(l.items).toHaveLength(6);
    expect(l.items.at(-1)).toEqual({ page: "https://e-hentai.org/s/h24/618395-25" });
    expect(l.next).toBeUndefined();
    expect(calls.some((c) => c.url.includes("api.php"))).toBe(false);
  });

  it("resolves an image page to the image, and fails on the quota picture", async () => {
    site({
      "https://e-hentai.org/s/ok/1-1": `<div id="i3"><a><img id="img" src="https://h.hath.network/h/abc/IMG_0032.webp" style="height:1808px"></a></div>`,
      "https://e-hentai.org/s/limit/1-2": `<div id="i3"><img id="img" src="https://ehgt.org/g/509.gif"></div>`,
    });
    expect(await ehentai.resolve!(env, "https://e-hentai.org/s/ok/1-1")).toBe("https://h.hath.network/h/abc/IMG_0032.webp");
    await expect(ehentai.resolve!(env, "https://e-hentai.org/s/limit/1-2")).rejects.toThrow("bandwidth");
  });
});

describe("hitomi", () => {
  const A = "5e4dd8fcc183062842ee3bf02392a05b735688be7e6064784b813c822722a346"; // g = 0x634 = 1588
  const B = "27c99fd7b306bbace5aa2e7928279bdd9a9c78633255f4ae8ce3aa4f33cbf175"; // g = 0x517 = 1303
  const info = {
    blocked: 0,
    id: 1000,
    title: "Honjitsu no Otooshi 2006 Summer",
    japanese_title: "本日のお通し",
    type: "doujinshi",
    language: "japanese",
    date: "2007-05-25 21:39:00-05",
    datepublished: "2006-08-11",
    artists: [{ artist: "nagisawa you", url: "/artist/x" }],
    groups: [{ group: "nagisawaya", url: "/group/x" }, { group: "simasima system", url: "/group/y" }],
    parodys: [{ parody: "zero no tsukaima", url: "/series/x" }],
    characters: [{ character: "louise francoise", url: "/character/x" }],
    tags: [{ tag: "c70", url: "/tag/c70" }, { tag: "footjob", female: 1, male: "", url: "/tag/x" }],
    files: [{ hash: A, name: "1.jpg", hasavif: 1, width: 1, height: 1 }, { hash: B, name: "2.png", width: 1, height: 1 }],
  };
  const gg = `'use strict';\ngg = { m: function(g) {\nvar o = 1;\nswitch (g) {\ncase 1588:\ncase 99:\no = 0; break;\n}\nreturn o;\n},\ns: function(h) { var m = /(..)(.)$/.exec(h); return parseInt(m[2]+m[1], 16).toString(10); },\nb: '1794492002/'\n};`;
  it("reads the gallery info and forges the image URLs from gg.js", async () => {
    site({ "https://ltn.gold-usergeneratedcontent.net/galleries/1000.js": `var galleryinfo = ${JSON.stringify(info)}`, "https://ltn.gold-usergeneratedcontent.net/gg.js": gg });
    const l = await run(hitomi, "https://hitomi.la/doujinshi/honjitsu-japanese-1000.html");
    expect(l.source).toBe("https://hitomi.la/galleries/1000.html");
    expect(l.title).toBe(info.title);
    expect(urls(l.items)).toEqual([
      `https://w1.gold-usergeneratedcontent.net/1794492002/1588/${A}.webp`, // in the switch: subdomain 0 + 1
      `https://2.gold-usergeneratedcontent.net/images/1794492002/1303/${B}.png`, // no webp: the original, default subdomain 1 + 1
    ]);
    expect(l.tags).toEqual(["nagisawa_you", "nagisawaya", "simasima_system", "zero_no_tsukaima", "louise_francoise", "c70", "footjob", "japanese", "doujinshi"]);
    expect(l.data).toMatchObject({ id: 1000, japanese_title: "本日のお通し", artists: ["nagisawa_you"], parodies: ["zero_no_tsukaima"], pages: 2, date: "2007-05-25 21:39:00-05", published: "2006-08-11" });
    expect(hitomi.headers).toEqual({ Referer: "https://hitomi.la/" });
    expect(new Headers(calls[0].init?.headers).get("Referer")).toBe("https://hitomi.la/");
  });
});

describe("imhentai", () => {
  const page = `<div class="right_details"><h1>(C71) [Arisan-Antenna (Koari)] Eat The Rich! (Sukatto Golf Pangya)</h1><p class="subtitle">(C71) 日本語</p>
    <ul class="galleries_info"><li><span class='tags_text'>Parodies:</span> <a class='tag btn' href='/parody/pangya/'>pangya <span class='badge'>132</span> </a></li>
    <li><span class='tags_text'>Tags:</span> <a class='tag btn' href='/tag/catgirl/'>catgirl <span class='badge'>30</span> </a><a class='tag btn' href='/tag/sole-male/'>sole male <span class='badge'>29</span> </a></li>
    <li><a class='tag btn' href='/artist/koari/'>koari</a></li><li><a href='/group/arisan-antenna/'>arisan-antenna</a></li><li><a href='/language/japanese/'>japanese</a></li><li><a href='/category/doujinshi/'>doujinshi</a></li>
    <li class="pages">Pages: 3</li></ul></div>`;
  const reader = `<img id="gimg" class="preloader image_1" src="https://m1.imhentai.xxx/001/8b7a63vwdj/1.jpg"><script>var g_th = $.parseJSON('{"1":"j,1050,1500","2":"p,1050,1500","3":"w,1050,1500"}');</script>`;
  it("lists the pages from the reader and reads the tags of the gallery", async () => {
    site({ "https://imhentai.xxx/gallery/1/": page, "https://imhentai.xxx/view/1/1/": reader });
    const l = await run(imhentai, "https://imhentai.xxx/gallery/1/");
    expect(l.source).toBe("https://imhentai.xxx/gallery/1/");
    expect(l.title).toBe("(C71) Eat The Rich! (Sukatto Golf Pangya)"); // [textual tags] dropped
    expect(urls(l.items)).toEqual(["https://m1.imhentai.xxx/001/8b7a63vwdj/1.jpg", "https://m1.imhentai.xxx/001/8b7a63vwdj/2.png", "https://m1.imhentai.xxx/001/8b7a63vwdj/3.webp"]);
    expect(l.tags).toEqual(["pangya", "catgirl", "sole_male", "koari", "arisan_antenna", "japanese", "doujinshi"]);
    expect(l.data).toMatchObject({ id: "1", title: "(C71) [Arisan-Antenna (Koari)] Eat The Rich! (Sukatto Golf Pangya)", subtitle: "(C71) 日本語", artists: ["koari"], groups: ["arisan_antenna"], parodies: ["pangya"], pages: 3 });
    expect(imhentai.headers).toEqual({ Referer: "https://imhentai.xxx/" });
  });
});

describe("hentaifox", () => {
  const page = `<div class="info"><h1>Winter&#39;s Tale</h1>
    <ul class="parodies"><li><a class='tag_btn ' href='/parody/fate-stay-night/'>fate stay night <span class='t_badge'>505</span></a></li></ul>
    <ul class="characters"><li><a class='tag_btn ' href='/character/rin-tosaka/'>rin tosaka</a></li></ul>
    <ul class="tags"><li><a class='tag_btn ' href='/tag/anal/'>anal</a></li></ul>
    <ul class="artists"><li><a class='tag_btn ' href='/artist/zenki/'>zenki</a></li></ul>
    <ul class="languages"><li><a class='tag_btn' href='/language/english/'>english</a></li></ul>
    <ul class="categories"><li><a class='tag_btn' href='/category/doujinshi/'>doujinshi</a></li></ul>
    <span class="i_text pages">Pages: 2</span><span class="i_text pages">Posted: 19 years ago</span></div>`;
  const reader = `<a class="next_img"><img id="gimg" class="lazy" src="data:image/svg+xml,x" data-src="https://i.hentaifox.com/001/12331/1.jpg"></a><script>var g_th = $.parseJSON('{"1":"j,720,1000","2":"p,720,1000"}');</script>`;
  it("lists the pages from the reader and reads the tags", async () => {
    site({ "https://hentaifox.com/gallery/1/": page, "https://hentaifox.com/g/1/1/": reader });
    const l = await run(hentaifox, "https://hentaifox.com/gallery/1/");
    expect(l.source).toBe("https://hentaifox.com/gallery/1/");
    expect(l.title).toBe("Winter's Tale");
    expect(urls(l.items)).toEqual(["https://i.hentaifox.com/001/12331/1.jpg", "https://i.hentaifox.com/001/12331/2.png"]);
    expect(l.tags).toEqual(["fate_stay_night", "rin_tosaka", "anal", "zenki", "english", "doujinshi"]);
    expect(l.data).toMatchObject({ id: "1", title: "Winter's Tale", parodies: ["fate_stay_night"], characters: ["rin_tosaka"], artists: ["zenki"], languages: ["english"], categories: ["doujinshi"], pages: 2 });
  });
});

describe("asmhentai", () => {
  const page = `<div class="info"><h1>(C88) [Z-FRONT (Kagato)] Seijya na Yuusya (Rokka no Yuusha)</h1><h2>(C88) 性者な勇者</h2><ul>
    <div class="tags"><h3>Parodies:</h3><div class="tag_list"><a href="/parody/rokka-no-yuusha/"><span class="badge tag">rokka no yuusha <span class="gallery_count">(7)</span></span></a></div></div></ul>
    <ul><div class="tags"><h3>Tags:</h3><div class="tag_list"><a href="/tag/big-breasts/"><span class="badge tag">big breasts <span class="gallery_count">(235,177)</span></span></a></div></div></ul>
    <ul><div class="tags"><h3>Artists:</h3><div class="tag_list"><a href="/artist/kagato/"><span class="badge tag">kagato</span></a></div></div></ul>
    <div class="pages"><h3>Pages: 3</h3></div></div>`;
  const reader = `<button class="pages_btn"><span class="cr">1</span> <span class="sp">of</span> <span class="tp">3</span></button>
    <div class="reader_overlay"><a class="fw_img"><img id="fimg" class="lazy" src="data:image/svg+xml,x" data-src="//images.asmhentai.com/001/1/1.jpg"></a></div>`;
  it("forges the pages from the first image and the page count", async () => {
    site({ "https://asmhentai.com/g/1/": page, "https://asmhentai.com/gallery/1/1/": reader });
    const l = await run(asmhentai, "https://asmhentai.com/g/1/");
    expect(l.source).toBe("https://asmhentai.com/g/1/");
    expect(l.title).toBe("(C88) [Z-FRONT (Kagato)] Seijya na Yuusya (Rokka no Yuusha)");
    expect(urls(l.items)).toEqual(["https://images.asmhentai.com/001/1/1.jpg", "https://images.asmhentai.com/001/1/2.jpg", "https://images.asmhentai.com/001/1/3.jpg"]);
    expect(l.tags).toEqual(["rokka_no_yuusha", "big_breasts", "kagato"]);
    expect(l.data).toMatchObject({ id: "1", subtitle: "(C88) 性者な勇者", parodies: ["rokka_no_yuusha"], tags: ["big_breasts"], artists: ["kagato"], pages: 3 });
  });
});

describe("8muses", () => {
  const crumbs = (...names: string[]) => `<div class="top-menu-breadcrumb"><ol><li><a href="/porn"><i class="fa fa-home"></i></a></li>${names.map((n) => `<li><a href="/porn/album/${n.replace(/ /g, "-")}">${n}</a></li>`).join("")}</ol></div>`;
  const tile = (n: number) => `<a class="c-tile" href="/porn/picture/Various-Authors/Disarten-Comics/Artwork-2/${n}"><div class="image"><img src="/image/th/hash${n}.jpg"></div></a>`;
  const path = "/porn/album/Various-Authors/Disarten-Comics/Artwork-2";
  it("lists a leaf album: title, publisher and artist tags, large images", async () => {
    site({
      [`https://comics.8muses.com${path}`]: crumbs("Various Authors", "Disarten Comics", "Artwork 2") + `<div class="gallery">${tile(1)}${tile(2)}</div>`,
      "https://comics.8muses.com/porn/picture/Various-Authors/Disarten-Comics/Artwork-2/1": `<div class="album-tags"><a href="/search/tag/big-boobs">big boobs</a><a href="/search/tag/milf">milf</a></div>`,
    });
    const l = await run(muses, `https://www.8muses.com${path}`);
    expect(l.source).toBe(`https://comics.8muses.com${path}`);
    expect(l.title).toBe("Artwork 2");
    expect(urls(l.items)).toEqual(["https://comics.8muses.com/image/fl/hash1.jpg", "https://comics.8muses.com/image/fl/hash2.jpg"]);
    expect(l.tags).toEqual(["disarten_comics", "big_boobs", "milf"]); // "various authors" is not a publisher; its second crumb is the artist
    expect(l.data).toMatchObject({ publisher: "Various Authors", artists: ["Disarten Comics"], circles: [], series: [], tags: ["big boobs", "milf"], pages: 2 });
  });
  it("adds the series to the title of a publisher's album", async () => {
    site({
      "https://comics.8muses.com/porn/album/MilfToon-Comics/Drawn-Sex/Issue-1": crumbs("MilfToon Comics", "Drawn Sex", "Issue 1") + `<div class="gallery">${tile(1)}</div>`,
      "https://comics.8muses.com/porn/picture/Various-Authors/Disarten-Comics/Artwork-2/1": "",
    });
    const l = await run(muses, "https://comics.8muses.com/porn/album/MilfToon-Comics/Drawn-Sex/Issue-1");
    expect(l.title).toBe("Drawn Sex - Issue 1");
    expect(l.tags).toEqual(["milftoon_comics", "drawn_sex"]);
    expect(l.data).toMatchObject({ circles: ["MilfToon Comics"], series: ["Drawn Sex"], artists: [] });
  });
  it("refuses a list of albums", async () => {
    site({ "https://comics.8muses.com/porn/album/Various-Authors": crumbs("Various Authors") + `<div class="gallery"><a class="c-tile" href="/porn/album/Various-Authors/X"><img src="/image/th/a.jpg"></a></div>` });
    await expect(run(muses, "https://comics.8muses.com/porn/album/Various-Authors")).rejects.toThrow("not an album");
  });
});

describe("multporn", () => {
  const page = `<head><link rel="shortlink" href="https://multporn.net/node/21"><meta name="dcterms.date" content="2015-06-01T14:53-04:00">
    <script>jQuery.extend(Drupal.settings, {"juicebox":{"x":{"configUrl":"\\/juicebox\\/xml\\/field\\/node\\/21\\/field_com_pages\\/full?checksum=b82863","containerId":"x"}}});</script></head>
    <ul class="menu"><li><a href="/comics">menu</a></li></ul>
    <h1 class="title" id="page-title"> Adult Time Mini </h1>
    <article class="node node-comics"><ul class="links inline"><li><a href="/authors_comics/coldfusion">ColdFusion</a></li></ul>
    <ul class="links inline"><li><a href="/comics/adventure_time">Adventure Time</a></li><li><a href="/comics/ongoings">Ongoings</a></li></ul>
    <ul class="links inline"><li><a href="/characters/finn_the_human">Finn the Human</a></li></ul>
    <ul class="links inline"><li><a href="/category/fantasy">Fantasy</a></li><li><a href="/user_tags/licking_tag">Licking</a></li><li><a href="/user_tags/young_tag?r=3">Young</a></li></ul></article>`;
  const xml = `<juicebox><image imageURL="https://multporn.net/m/p1.png" linkURL="https://multporn.net/f/p1.png?a=1&amp;b=2"/><image imageURL="m2" linkURL="https://multporn.net/f/p2.png"/><image imageURL="m2" linkURL="https://multporn.net/f/p2.png"/></juicebox>`;
  it("reads the Juicebox XML and the term links of the node", async () => {
    site({ "https://multporn.net/comics/adult_time_mini": page, "https://multporn.net/juicebox/xml/field/node/21/field_com_pages/full?checksum=b82863": xml });
    const l = await run(multporn, "https://multporn.net/comics/adult_time_mini/");
    expect(l.source).toBe("https://multporn.net/comics/adult_time_mini");
    expect(l.title).toBe("Adult Time Mini");
    expect(urls(l.items)).toEqual(["https://multporn.net/f/p1.png?a=1&b=2", "https://multporn.net/f/p2.png"]);
    expect(l.tags).toEqual(["coldfusion", "adventure_time", "ongoing", "fantasy", "licking", "young", "finn_the_human"]);
    expect(l.data).toMatchObject({ title: "Adult Time Mini", artists: ["coldfusion"], series: ["adventure_time"], characters: ["finn_the_human"], tags: ["ongoing", "fantasy", "licking", "young"], pages: 2, date: "2015-06-01T14:53-04:00" });
    expect(new Headers(calls[1].init?.headers).get("Referer")).toBe("https://multporn.net/comics/adult_time_mini");
  });
  it("fails on a page without a gallery", async () => {
    site({ "https://multporn.net/comics/adventure_time": `<h1 id="page-title">Adventure Time</h1>` });
    await expect(run(multporn, "https://multporn.net/comics/adventure_time")).rejects.toThrow("no images");
  });
});

describe("allporncomic", () => {
  const S = "https://allporncomic.com/porncomic/10-am/";
  const chapterLi = (slug: string, date: boolean) =>
    `<li class="wp-manga-chapter "> <a href="${S}${slug}/"> ${slug} </a><span class="chapter-release-date">${date ? "<i>July 25, 2020</i>" : `<a href="${S}${slug}/" class="c-new-tag"></a>`}</span></li>`;
  const series = (n: number) => `<head><title>10 AM [LoseKorntrol] Porn Comic | AllPornComic</title></head>
    <div class="post-content"><div class="summary-content"><div class="artist-content"><a href="https://allporncomic.com/porncomicartist/hijab-3dx/" rel="tag">Hijab 3DX</a></div></div>
    <div class="summary-content"><div class="genres-content"><a href="https://allporncomic.com/porncomic-category/3dd/" rel="tag">3D</a>, <a href="https://allporncomic.com/porncomic-category/glory-hole/" rel="tag">Glory Hole</a></div></div>
    <div class="summary-content"><a href="https://allporncomic.com/characters/lara-croft/">Lara Croft</a></div>
    <div class="summary-content">OnGoing</div></div>
    <ul class="main"><li class="wp-manga-chapter "> <a href="${S}fake1/"> tb1794411814 </a><span class="chapter-release-date"><a class="c-new-tag"></a></span></li>
    ${Array.from({ length: n }, (_, i) => chapterLi(`c${n - i}`, true)).join("")}${chapterLi("fake2", false)}</ul>`;
  const chapterPage = (k: string) => `<head><title>10 AM - ${k} - AllPornComic</title></head><div class="page-break "> <img id="image-0" data-src=" https://cdn.test/${k}/01.jpg " class="wp-manga-chapter-img"></div><div class="page-break "> <img id="image-1" data-src="https://cdn.test/${k}/02.jpg"></div><div class="page-break "> <img id="image-1" data-src="https://cdn.test/${k}/02.jpg"></div>`;
  const chapters = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${S}c${i + 1}/`, chapterPage(`c${i + 1}`)]));

  it("takes the real chapters of a series, the oldest first, and 19 chapters per step", async () => {
    site({ [S]: series(21), ...chapters(21) });
    const l = await run(allporncomic, "https://allporncomic.com/manga/10-am/");
    expect(l.source).toBe(S);
    expect(l.title).toBe("10 AM [LoseKorntrol]");
    expect(l.tags).toEqual(["hijab_3dx", "3d", "glory_hole", "lara_croft", "ongoing"]);
    expect(l.data).toMatchObject({ title: "10 AM [LoseKorntrol]", artists: ["Hijab 3DX"], tags: ["3D", "Glory Hole"], characters: ["Lara Croft"], status: "ongoing", chapters: 21 });
    expect(l.items).toHaveLength(38);
    expect(urls(l.items).slice(0, 3)).toEqual(["https://cdn.test/c1/01.jpg", "https://cdn.test/c1/02.jpg", "https://cdn.test/c2/01.jpg"]); // trimmed, deduped
    expect(calls).toHaveLength(20); // the series page and 19 chapters
    expect(JSON.parse(l.next!)).toEqual([`${S}c20/`, `${S}c21/`]);

    const l2 = await run(allporncomic, "https://allporncomic.com/porncomic/10-am/", l.next);
    expect(urls(l2.items)).toEqual(["https://cdn.test/c20/01.jpg", "https://cdn.test/c20/02.jpg", "https://cdn.test/c21/01.jpg", "https://cdn.test/c21/02.jpg"]);
    expect(l2.next).toBeUndefined();
  });

  it("takes all chapters when none has a date", async () => {
    site({ [S]: `<head><title>X Porn Comic</title></head><ul>${chapterLi("a", false)}${chapterLi("b", false)}</ul>`, [`${S}a/`]: chapterPage("a"), [`${S}b/`]: chapterPage("b") });
    const l = await run(allporncomic, S);
    expect(urls(l.items).map((u) => u.split("/")[3])).toEqual(["b", "b", "a", "a"]);
  });

  it("imports only the chapter of a chapter link", async () => {
    site({ [`${S}c1/`]: chapterPage("c1") });
    const l = await run(allporncomic, `${S}c1/`);
    expect(l.source).toBe(`${S}c1/`);
    expect(l.title).toBe("10 AM - c1");
    expect(urls(l.items)).toEqual(["https://cdn.test/c1/01.jpg", "https://cdn.test/c1/02.jpg"]);
    expect(l.next).toBeUndefined();
  });
});

describe("kemono", () => {
  const profile = { id: "5564244", name: "theobrobine", service: "patreon", post_count: 3, indexed: "2020-09-30T06:13:38", updated: "2026-03-20T21:56:49" };
  const post = (id: string, tags: string[] = []) => ({
    id,
    user: "5564244",
    service: "patreon",
    title: `Post ${id}`,
    content: "text",
    published: "2026-03-02T12:06:15",
    file: { name: "a.png", path: `/aa/bb/${id}.png` },
    attachments: [{ name: "a.png", path: `/aa/bb/${id}.png` }, { name: "b.zip", path: `/cc/dd/${id}.bin` }, { name: "c.gif", path: `/ee/ff/${id}.gif` }, { name: "d.mp4", path: `/gg/hh/${id}.mp4` }],
    tags,
  });
  const api = "https://kemono.cr/api/v1/patreon/user/5564244";

  it("lists one post: images only, no duplicates, tags of the post and the creator", async () => {
    site({ [`${api}/post/152036345`]: { post: post("152036345", ["animation", "cowgirl position"]), attachments: [] }, [`${api}/profile`]: profile });
    const l = await run(kemono, "https://kemono.su/patreon/user/5564244/post/152036345");
    expect(l.source).toBe("https://kemono.cr/patreon/user/5564244/post/152036345");
    expect(l.title).toBe("Post 152036345");
    expect(urls(l.items)).toEqual(["https://kemono.cr/data/aa/bb/152036345.png", "https://kemono.cr/data/ee/ff/152036345.gif"]);
    expect(l.tags).toEqual(["theobrobine", "patreon", "animation", "cowgirl_position"]);
    expect(l.data).toMatchObject({ creator: { name: "theobrobine", post_count: 3 }, post: { id: "152036345", title: "Post 152036345", published: "2026-03-02T12:06:15", tags: ["animation", "cowgirl position"] } });
    expect(new Headers(calls[0].init?.headers).get("Accept")).toBe("text/css");
    expect(kemono.headers).toEqual({ Referer: "https://kemono.cr/" });
  });

  it("lists all posts of a creator as one comic, the oldest first", async () => {
    // 3 posts, the API gives the newest first
    site({ [`${api}/profile`]: profile, [`${api}/posts?o=0`]: [post("3", ["t3"]), post("2"), post("1")] });
    const l = await run(kemono, "https://kemono.cr/patreon/user/5564244");
    expect(l.source).toBe("https://kemono.cr/patreon/user/5564244");
    expect(l.title).toBe("theobrobine");
    expect(l.tags).toEqual(["theobrobine", "patreon"]);
    expect(l.data).toMatchObject({ creator: { id: "5564244", post_count: 3 } });
    expect(urls(l.items).filter((u) => u.endsWith(".png"))).toEqual(["https://kemono.cr/data/aa/bb/1.png", "https://kemono.cr/data/aa/bb/2.png", "https://kemono.cr/data/aa/bb/3.png"]);
    const last = l.items.at(-1)!;
    expect(last).toMatchObject({ url: "https://kemono.cr/data/ee/ff/3.gif", tags: ["t3"], data: { creator: { id: "5564244", service: "patreon" }, post: { id: "3", title: "Post 3" } } });
    expect(l.next).toBeUndefined();
  });

  it("goes from the last offset to 0, 20 API calls per step", async () => {
    const routes: Record<string, Route> = { [`${api}/profile`]: { ...profile, post_count: 1020 } };
    for (let o = 0; o <= 1000; o += 50) routes[`${api}/posts?o=${o}`] = [post(`n${o}`), post(`o${o}`)]; // newest first in a page
    site(routes);
    const l = await run(kemono, "https://kemono.cr/patreon/user/5564244");
    expect(calls).toHaveLength(21); // the profile and 20 pages: o=1000 … 50
    expect(urls(l.items)[0]).toBe("https://kemono.cr/data/aa/bb/o1000.png");
    expect(urls(l.items)[2]).toBe("https://kemono.cr/data/aa/bb/n1000.png");
    expect(l.next).toBe("0");
    const l2 = await run(kemono, "https://kemono.cr/patreon/user/5564244", l.next);
    expect(l2.title).toBeNull();
    expect(urls(l2.items)[0]).toBe("https://kemono.cr/data/aa/bb/o0.png");
    expect(l2.next).toBeUndefined();
    expect(calls).toHaveLength(22);
  });
});
