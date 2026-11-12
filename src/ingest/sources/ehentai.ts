// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: EhentaiContent.kt, EHentaiParser.kt. No ExHentai (needs a login).
import type { Env } from "../../env";
import { fetchPage } from "../fetch";
import type { GallerySource, Item } from "../gallery";
import { only, scrape, tagName, uniq } from "./html";

const PAGES_PER_STEP = 19; // listing pages per step (+1 request of the metadata)
const HEADERS = { Cookie: "nw=1" }; // skips the content warning page

interface Meta {
  gid: number;
  token: string;
  title: string;
  title_jpn: string;
  category: string;
  uploader: string;
  posted: string;
  filecount: string;
  filesize: number;
  rating: string;
  tags: string[]; // "namespace:tag"
}

const gallery = (url: URL) => url.pathname.split("/").filter(Boolean).slice(1, 3); // [gid, token]

/** Image pages of one listing page `?p=N`, and the number of the listing pages. */
async function listing(env: Env, base: string, p: number) {
  const res = await fetchPage(env, `${base}?p=${p}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`e-hentai: ${res.status}`);
  const hits = await scrape(await res.text(), "#gdt a", "table.ptt a");
  const pages = Math.max(1, ...only(hits, "table.ptt a").map((h) => +h.text || 0));
  return { pages, links: only(hits, "#gdt a").map((h) => h.attrs.href).filter(Boolean) };
}

export const ehentai: GallerySource = {
  name: "e-hentai",
  match: (url) => url.hostname === "e-hentai.org" && /^\/g\/\d+\/[0-9a-f]+/.test(url.pathname),
  async fetch(env, url, cursor) {
    const [gid, token] = gallery(url);
    const base = `https://e-hentai.org/g/${gid}/${token}/`;
    let title: string | null = null;
    let data: unknown;
    let tags: string[] | undefined;
    if (!cursor) {
      const res = await fetchPage(env, "https://api.e-hentai.org/api.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "gdata", gidlist: [[+gid, token]], namespace: 1 }),
      });
      const meta = (await res.json<{ gmetadata?: Meta[] }>()).gmetadata?.[0];
      if (!meta || !meta.title) throw new Error("e-hentai: no metadata");
      title = meta.title;
      tags = uniq([...meta.tags.map((t) => tagName(t.split(":").slice(1).join(":"))), tagName(meta.category)]);
      data = { ...meta, pages: +meta.filecount };
    }
    const items: Item[] = [];
    let p = +(cursor ?? 0);
    let last = p + 1; // the number of listing pages is known after the first one
    for (let n = 0; n < PAGES_PER_STEP && p < last; n++, p++) {
      const l = await listing(env, base, p);
      last = l.pages;
      items.push(...l.links.map((page) => ({ page })));
    }
    return { source: base, title, tags, data, items, next: p < last ? String(p) : undefined };
  },
  async resolve(env, page) {
    const res = await fetchPage(env, page, { headers: HEADERS });
    if (!res.ok) throw new Error(`e-hentai: ${res.status} ${page}`);
    const hits = await scrape(await res.text(), "img#img", "#i3 img");
    const src = hits.map((h) => h.attrs.src).find(Boolean);
    if (!src || src.includes("/509.gif")) throw new Error(`e-hentai: no image (bandwidth limit?) ${page}`); // 509.gif: the quota is spent
    return src;
  },
};
