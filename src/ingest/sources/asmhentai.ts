// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: ASMHentaiContent.kt, ASMHentaiParser.kt.
import type { Env } from "../../env";
import { fetchPage } from "../fetch";
import type { GallerySource } from "../gallery";
import { imgSrc, linkTags, only, scrape } from "./html";

const SITE = "https://asmhentai.com";

const text = async (env: Env, url: string) => {
  const res = await fetchPage(env, url);
  if (!res.ok) throw new Error(`asmhentai: ${res.status} ${url}`);
  return res.text();
};

export const asmhentai: GallerySource = {
  name: "asmhentai",
  headers: { Referer: `${SITE}/` },
  match: (url) => url.hostname === "asmhentai.com" && /^\/(g|gallery)\/\d+/.test(url.pathname),
  async fetch(env, url) {
    const id = url.pathname.split("/")[2];
    const [page, reader] = await Promise.all([text(env, `${SITE}/g/${id}/`), text(env, `${SITE}/gallery/${id}/1/`)]);
    const hits = await scrape(page, "div.info h1", "div.info h2", "div.info div.tags a", "div.pages h3");
    const { tags, groups } = linkTags(only(hits, "div.info div.tags a"));
    const rd = await scrape(reader, ".reader_overlay a img, .full_image a img, .full_gallery a img", ".pages_btn");
    const img = rd.find((h) => h.sel !== ".pages_btn");
    const count = +(only(rd, ".pages_btn")[0]?.text.match(/\d+/g)?.pop() ?? 0); // "1 of 18"
    if (!img || !count) throw new Error("asmhentai: no pages");
    const first = imgSrc(img.attrs, SITE);
    const ext = first.match(/\.\w+$/)![0]; // the extension of the first page is taken for all, as Hentoid does
    const dir = first.replace(/[^/]*$/, "");
    const title = only(hits, "div.info h1")[0]?.text ?? "";
    return {
      source: `${SITE}/g/${id}/`,
      title: title || null,
      tags,
      data: { id, title, subtitle: only(hits, "div.info h2")[0]?.text, ...groups, pages: count },
      items: Array.from({ length: count }, (_, i) => ({ url: `${dir}${i + 1}${ext}` })),
    };
  },
};
