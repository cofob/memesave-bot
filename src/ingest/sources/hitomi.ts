// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: HitomiContent.kt, HitomiParser.kt (the page URLs come from gg.js, as in the site reader).
import { fetchPage } from "../fetch";
import type { GallerySource } from "../gallery";
import { tagName, uniq } from "./html";

const CDN = "gold-usergeneratedcontent.net";
const REFERER = "https://hitomi.la/";

type Named = Record<string, unknown>
interface Info {
  id: number | string;
  title: string;
  japanese_title?: string | null;
  type?: string;
  language?: string | null;
  date?: string;
  datepublished?: string | null;
  artists?: Named[] | null;
  groups?: Named[] | null;
  parodys?: Named[] | null;
  characters?: Named[] | null;
  tags?: (Named & { female?: unknown; male?: unknown })[] | null;
  files: { hash: string; name: string; haswebp?: number; hasavif?: number }[];
}

/** gg.js: the build path `b`, and the subdomain number of a hash (`m` is a switch over the numbers that map to 0). */
function parseGg(js: string) {
  const zero = new Set([...js.matchAll(/case (\d+):/g)].map((m) => +m[1]));
  const dflt = +(js.match(/var o = (\d)/)?.[1] ?? 1);
  const hit = +(js.match(/\bo = (\d);\s*break/)?.[1] ?? 0);
  const b = js.match(/b: '([^']*)'/)?.[1];
  if (b === undefined) throw new Error("hitomi: gg.js");
  return (hash: string, webp: boolean, ext: string) => {
    const g = parseInt(hash.slice(-1) + hash.slice(-3, -1), 16);
    const sub = 1 + (zero.has(g) ? hit : dflt);
    return webp ? `https://w${sub}.${CDN}/${b}${g}/${hash}.webp` : `https://${sub}.${CDN}/images/${b}${g}/${hash}.${ext}`;
  };
}

const names = (a: Named[] | null | undefined, key: string) => (a ?? []).map((x) => tagName(String(x[key])));

export const hitomi: GallerySource = {
  name: "hitomi",
  headers: { Referer: REFERER },
  match: (url) => url.hostname === "hitomi.la" && /(?:-|\/(?:galleries|reader)\/)\d+\.html$/.test(url.pathname),
  async fetch(env, url) {
    const id = url.pathname.match(/(\d+)\.html$/)![1];
    const [js, gg] = await Promise.all([`https://ltn.${CDN}/galleries/${id}.js`, `https://ltn.${CDN}/gg.js`].map((u) => fetchPage(env, u, { headers: { Referer: REFERER } })));
    if (!js.ok || !gg.ok) throw new Error(`hitomi: ${js.status} ${gg.status}`);
    const text = await js.text(); // `var galleryinfo = {…}`
    const info: Info = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const urlOf = parseGg(await gg.text());
    const groups = {
      artists: names(info.artists, "artist"),
      groups: names(info.groups, "group"),
      parodies: names(info.parodys, "parody"),
      characters: names(info.characters, "character"),
      tags: (info.tags ?? []).map((t) => tagName(String(t.tag))),
      languages: info.language ? [tagName(info.language)] : [],
      categories: info.type ? [tagName(info.type)] : [],
    };
    return {
      source: `https://hitomi.la/galleries/${info.id}.html`,
      title: info.title,
      tags: uniq(Object.values(groups).flat()),
      data: { id: info.id, title: info.title, japanese_title: info.japanese_title, ...groups, pages: info.files.length, date: info.date, published: info.datepublished },
      items: info.files.map((f) => ({ url: urlOf(f.hash, !!(f.haswebp || f.hasavif), f.name.split(".").pop()!) })),
    };
  },
};
