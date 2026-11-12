// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: AllPornComicContent.kt, AllPornComicParser.kt.
import type { Env } from "../../env";
import { fetchPage } from "../fetch";
import type { GallerySource, Item, Listing } from "../gallery";
import { imgSrc, only, scrape, tagName, uniq } from "./html";

const SITE = "https://allporncomic.com";
const CHAPTERS_PER_STEP = 19; // + the series page in the first step
// Term links of the series page by the first path segment: the group in data
const GROUPS: Record<string, string> = { "porncomicartist": "artists", "porncomic-artist": "artists", "porncomic-category": "tags", "porncomic-genre": "tags", characters: "characters", series: "series" };

const clean = (title: string) => title.replace(/\s*[-|]\s*AllPornComic$/, "").replace(/ Porn Comic$/, "").trim(); // "… Porn Comic | AllPornComic"

async function html(env: Env, url: string) {
  const res = await fetchPage(env, url);
  if (!res.ok) throw new Error(`allporncomic: ${res.status} ${url}`);
  return res.text();
}

/** The title and the images of one chapter page, in order. */
async function chapter(env: Env, url: string) {
  const hits = await scrape(await html(env, url), "head title", "[class^=page-break] img");
  return { title: clean(only(hits, "head title")[0]?.text ?? ""), items: uniq(only(hits, "[class^=page-break] img").map((i) => imgSrc(i.attrs, url))).map((u) => ({ url: u })) };
}

/** One step: up to CHAPTERS_PER_STEP chapters of `urls`; the cursor holds the rest. `meta` is of the first step. */
async function step(env: Env, source: string, urls: string[], meta?: { title: string; tags: string[]; data: unknown }): Promise<Listing> {
  const items: Item[] = [];
  let title = meta?.title ?? null;
  for (const u of urls.slice(0, CHAPTERS_PER_STEP)) {
    const c = await chapter(env, u);
    items.push(...c.items);
    title ??= c.title;
  }
  const rest = urls.slice(CHAPTERS_PER_STEP);
  return { source, title, tags: meta?.tags, data: meta?.data ?? { title }, items, next: rest.length ? JSON.stringify(rest) : undefined };
}

export const allporncomic: GallerySource = {
  name: "allporncomic",
  match: (url) => url.hostname.endsWith("allporncomic.com") && /^\/(porncomic|manga)\/[^/]+(\/[^/]+)?\/?$/.test(url.pathname),
  async fetch(env, url, cursor) {
    const [, slug, chapterSlug] = url.pathname.split("/").filter(Boolean); // [porncomic, series, chapter?]
    const series = `${SITE}/porncomic/${slug}/`; // the site serves series under /porncomic/ only
    if (cursor) return step(env, series, JSON.parse(cursor)); // the rest of the chapters
    if (chapterSlug) return step(env, `${series}${chapterSlug}/`, [`${series}${chapterSlug}/`]); // a chapter link: this chapter only

    const hits = await scrape(await html(env, series), "head title", ".post-content a", ".summary-content", "li.wp-manga-chapter > a", "li.wp-manga-chapter .chapter-release-date i");
    // The chapter list can hold fake chapters (random names, a "new" label instead of the date): when there are dated ones, only they count
    const chapters: { href: string; dated: boolean }[] = [];
    for (const h of hits) {
      if (h.sel === "li.wp-manga-chapter > a") chapters.push({ href: new URL(h.attrs.href, SITE).href, dated: false });
      else if (h.sel.endsWith(" i") && chapters.length) chapters.at(-1)!.dated = true;
    }
    const real = chapters.some((c) => c.dated) ? chapters.filter((c) => c.dated) : chapters;
    const urls = uniq(real.map((c) => c.href)).reverse(); // the list is newest first

    const groups: Record<string, string[]> = {};
    for (const a of only(hits, ".post-content a")) {
      const group = GROUPS[a.attrs.href?.match(/allporncomic\.com\/([^/]+)\//)?.[1] ?? ""];
      if (group && a.text) (groups[group] ??= []).push(a.text);
    }
    const status = only(hits, ".summary-content").map((h) => h.text.match(/ongoing|completed/i)?.[0].toLowerCase()).find(Boolean);
    const title = clean(only(hits, "head title")[0]?.text ?? "");
    const tags = uniq([...Object.values(groups).flat().map(tagName), status]);
    return step(env, series, urls, { title, tags, data: { title, ...groups, status, chapters: urls.length } });
  },
};
