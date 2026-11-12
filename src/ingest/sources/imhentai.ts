// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: ImhentaiContent.kt, ImhentaiParser.kt.
import type { Env } from "../../env";
import { fetchPage } from "../fetch";
import type { GallerySource } from "../gallery";
import { imgSrc, linkTags, numbered, only, scrape } from "./html";

const SITE = "https://imhentai.xxx";

const text = async (env: Env, url: string) => {
  const res = await fetchPage(env, url);
  if (!res.ok) throw new Error(`imhentai: ${res.status} ${url}`);
  return res.text();
};

export const imhentai: GallerySource = {
  name: "imhentai",
  headers: { Referer: `${SITE}/` },
  match: (url) => url.hostname === "imhentai.xxx" && /^\/gallery\/\d+/.test(url.pathname),
  async fetch(env, url) {
    const id = url.pathname.split("/")[2];
    const [page, reader] = await Promise.all([text(env, `${SITE}/gallery/${id}/`), text(env, `${SITE}/view/${id}/1/`)]);
    const hits = await scrape(page, "div.right_details h1", "div.right_details .subtitle", "ul.galleries_info a", "li.pages");
    const { tags, groups } = linkTags(only(hits, "ul.galleries_info a"));
    const formats = reader.match(/'(\{"1":.*?\})'/s)?.[1];
    const first = (await scrape(reader, "#gimg, .gthumb img"))[0]; // the page image, or the first thumbnail: both in the image dir
    if (!formats || !first) throw new Error("imhentai: no pages");
    const title = only(hits, "div.right_details h1")[0]?.text ?? "";
    const dir = imgSrc(first.attrs, SITE).replace(/[^/]*$/, "");
    return {
      source: `${SITE}/gallery/${id}/`,
      title: title.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim() || title || null, // Hentoid drops the [textual tags]
      tags,
      data: { id, title, subtitle: only(hits, "div.right_details .subtitle")[0]?.text, ...groups, pages: Number(only(hits, "li.pages")[0]?.text.match(/\d+/)?.[0]) || undefined },
      items: numbered(dir, JSON.parse(formats)).map((url) => ({ url })),
    };
  },
};
