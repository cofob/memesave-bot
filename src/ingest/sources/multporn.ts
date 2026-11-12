// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: MultpornContent.kt, MultpornParser.kt.
import { fetchPage } from "../fetch";
import type { GallerySource } from "../gallery";
import { decode, only, scrape, uniq } from "./html";

const SITE = "https://multporn.net";
// Term links of the node by their path: [the group in data, is it a tag]
const GROUPS: [string, string][] = [["/characters", "characters"], ["/hentai", "series"], ["/comics", "series"], ["/authors", "artists"], ["/category", "tags"], ["/user_tags", "tags"]];

/** Name of a term from its link: the last path segment (`finn_the_human`), without the `_tag` suffix of user tags. */
const term = (href: string) => decodeURIComponent(href.split("?")[0].split("/").pop()!).toLowerCase().replace(/_tag$/, "");

export const multporn: GallerySource = {
  name: "multporn",
  match: (url) => url.hostname === "multporn.net" && /^\/(comics|hentai_manga)\/[^/]+\/?$/.test(url.pathname),
  async fetch(env, url) {
    const path = url.pathname.replace(/\/$/, "");
    const res = await fetchPage(env, `${SITE}${path}`);
    if (!res.ok) throw new Error(`multporn: ${res.status}`);
    const html = await res.text();
    const hits = await scrape(html, "#page-title", "head meta[name='dcterms.date']", ".node .links a");
    // The image list is a Juicebox XML, its URL is in the settings script
    const xml = html.match(/\\?\/juicebox\\?\/xml\\?\/[^"]+/)?.[0].replaceAll("\\", "");
    if (!xml) throw new Error("multporn: no images");
    const gx = await fetchPage(env, new URL(xml, SITE).href, { headers: { Referer: `${SITE}${path}` } });
    if (!gx.ok) throw new Error(`multporn: ${gx.status} xml`);
    const images = uniq([...(await gx.text()).matchAll(/linkURL="([^"]*)"/g)].map((m) => decode(m[1])));
    const groups: Record<string, string[]> = {};
    for (const a of only(hits, ".node .links a")) {
      const href = new URL(a.attrs.href ?? "", SITE).pathname;
      const g = GROUPS.find(([prefix]) => href.startsWith(prefix));
      if (!g) continue;
      let [name, group] = [term(href), g[1]];
      if (name === "ongoings") [name, group] = ["ongoing", "tags"]; // the "ongoings" section is a status
      (groups[group] ??= []).push(name);
    }
    for (const k in groups) groups[k] = uniq(groups[k]);
    const title = only(hits, "#page-title")[0]?.text ?? "";
    return {
      source: `${SITE}${path}`,
      title: title || null,
      tags: uniq(Object.values(groups).flat()),
      data: { title, ...groups, pages: images.length, date: only(hits, "head meta[name='dcterms.date']")[0]?.attrs.content },
      items: images.map((u) => ({ url: u })),
    };
  },
};
