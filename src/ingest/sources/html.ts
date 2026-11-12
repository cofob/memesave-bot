// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: getImgSrc, tag and format-map helpers (ParseHelper.kt).
// HTML scraping on HTMLRewriter: the selectors in, the matching elements in document order out.

export interface Hit {
  sel: string; // the selector that matched
  attrs: Record<string, string>;
  text: string; // text of the element with its descendants, entities decoded, spaces collapsed
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decode = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, d, h, n) => (n ? (ENTITIES[n.toLowerCase()] ?? m) : String.fromCodePoint(d ? +d : parseInt(h, 16))));

/** The elements that match any of `sels`, in document order (an element that matches two selectors comes twice). */
export async function scrape(html: string, ...sels: string[]): Promise<Hit[]> {
  const hits: Hit[] = [];
  const rw = new HTMLRewriter();
  for (const sel of sels) {
    let cur: Hit;
    rw.on(sel, {
      element: (e) => void hits.push((cur = { sel, attrs: Object.fromEntries(e.attributes), text: "" })),
      text: (t) => void (cur.text += t.text),
    });
  }
  await rw.transform(new Response(html)).arrayBuffer();
  return hits.map((h) => ({ ...h, text: decode(h.text).replace(/\s+/g, " ").trim() }));
}

/** The hits of one selector. */
export const only = (hits: Hit[], sel: string) => hits.filter((h) => h.sel === sel);

/** First non-empty image attribute (Hentoid getImgSrc), as an absolute URL. */
export const imgSrc = (a: Record<string, string>, base: string) => {
  const src = ["data-src", "data-lazy-src", "data-lazysrc", "data-original", "src", "data-cfsrc"].map((k) => a[k]?.trim()).find(Boolean);
  return src ? new URL(src, base).href : "";
};

/** Tag name as in booru tags: lowercase, underscores for spaces. */
export const tagName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "_");

/** Unique values in order, empty ones dropped. */
export const uniq = <T>(a: (T | undefined | null | "")[]) => [...new Set(a.filter(Boolean) as T[])];

/** Image URLs of a gallery from the first page dir and the format map `{"1":"j,w,h",…}` (ImHentai, HentaiFox). */
export function numbered(dir: string, formats: Record<string, string>) {
  const ext: Record<string, string> = { p: "png", g: "gif", w: "webp" }; // anything else is jpg
  return Object.keys(formats).map((n) => `${dir}${n}.${ext[formats[n][0]] ?? "jpg"}`);
}

const TYPES: Record<string, string> = { artist: "artists", group: "groups", parody: "parodies", character: "characters", tag: "tags", language: "languages", category: "categories" };

/** Tags of the links `/<type>/<slug>/` (ImHentai, HentaiFox, AsmHentai): all of them as booru tags and grouped by type. */
export function linkTags(links: Hit[]) {
  const groups: Record<string, string[]> = {};
  for (const l of links) {
    const [type, slug] = (l.attrs.href ?? "").split("?")[0].split("/").filter(Boolean).slice(-2);
    if (TYPES[type] && slug) (groups[TYPES[type]] ??= []).push(tagName(decodeURIComponent(slug).replaceAll("-", " ")));
  }
  return { tags: uniq(Object.values(groups).flat()), groups };
}
