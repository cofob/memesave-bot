// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: HentaifoxContent.kt, HentaifoxParser.kt.
import type { Env } from "../../env";
import { fetchPage } from "../fetch";
import type { GallerySource } from "../gallery";
import { imgSrc, linkTags, numbered, only, scrape } from "./html";

const SITE = "https://hentaifox.com";

const text = async (env: Env, url: string) => {
  const res = await fetchPage(env, url);
  if (!res.ok) throw new Error(`hentaifox: ${res.status} ${url}`);
  return res.text();
};

export const hentaifox: GallerySource = {
  name: "hentaifox",
  headers: { Referer: `${SITE}/` },
  match: (url) => url.hostname === "hentaifox.com" && /^\/(gallery|g)\/\d+/.test(url.pathname),
  async fetch(env, url) {
    const id = url.pathname.split("/")[2];
    const [page, reader] = await Promise.all([text(env, `${SITE}/gallery/${id}/`), text(env, `${SITE}/g/${id}/1/`)]);
    const hits = await scrape(page, ".info h1", ".info a.tag_btn", ".info .pages");
    const { tags, groups } = linkTags(only(hits, ".info a.tag_btn"));
    const formats = reader.match(/'(\{"1":.*?\})'/s)?.[1]; // the page list has only the first thumbnails, the reader has the format map
    const first = (await scrape(reader, "#gimg"))[0];
    if (!formats || !first) throw new Error("hentaifox: no pages");
    const title = only(hits, ".info h1")[0]?.text ?? "";
    return {
      source: `${SITE}/gallery/${id}/`,
      title: title || null,
      tags,
      data: { id, title, ...groups, pages: Number(only(hits, ".info .pages")[0]?.text.match(/\d+/)?.[0]) || undefined },
      items: numbered(imgSrc(first.attrs, SITE).replace(/[^/]*$/, ""), JSON.parse(formats)).map((url) => ({ url })),
    };
  },
};
