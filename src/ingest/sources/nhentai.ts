// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: NhentaiContent.kt, NhentaiParser.kt (the site API v2 instead of the HTML).
import { fetchPage } from "../fetch";
import type { GallerySource } from "../gallery";
import { tagName, uniq } from "./html";

const TYPES: Record<string, string> = { artist: "artists", group: "groups", parody: "parodies", character: "characters", tag: "tags", language: "languages", category: "categories" };

interface Gallery {
  id: number;
  media_id: string;
  title: { english?: string; japanese?: string; pretty?: string };
  scanlator?: string;
  upload_date: number;
  num_pages: number;
  num_favorites: number;
  tags: { type: string; name: string }[];
  pages: { number: number; path: string }[];
}

export const nhentai: GallerySource = {
  name: "nhentai",
  match: (url) => url.hostname === "nhentai.net" && /^\/g\/\d+/.test(url.pathname),
  async fetch(env, url) {
    const id = url.pathname.split("/")[2];
    const res = await fetchPage(env, `https://nhentai.net/api/v2/galleries/${id}`);
    if (!res.ok) throw new Error(`nhentai: ${res.status}`);
    const g = await res.json<Gallery>();
    const groups: Record<string, string[]> = {};
    for (const t of g.tags) if (TYPES[t.type]) (groups[TYPES[t.type]] ??= []).push(tagName(t.name));
    const { english, japanese, pretty } = g.title;
    return {
      source: `https://nhentai.net/g/${g.id}/`,
      title: pretty || english || japanese || null,
      tags: uniq(Object.values(groups).flat()),
      data: { id: g.id, media_id: g.media_id, title: g.title, scanlator: g.scanlator, ...groups, pages: g.num_pages, favorites: g.num_favorites, uploaded: new Date(g.upload_date * 1000).toISOString() },
      items: g.pages.map((p) => ({ url: `https://i1.nhentai.net/${p.path}` })),
    };
  },
};
