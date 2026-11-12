// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: MusesContent.kt, MusesParser.kt.
import { fetchPage } from "../fetch";
import type { GallerySource } from "../gallery";
import { imgSrc, only, scrape, tagName, uniq } from "./html";

const HOST = "https://comics.8muses.com";
// Publishers whose second breadcrumb is an author, not a series (MusesContent.kt)
const WITH_AUTHORS = ["various authors", "fakku comics", "hentai and manga english", "renderotica comics", "tg comics", "affect3d comics", "johnpersons.com comics"];
const NOT_PUBLISHERS = ["various authors", "hentai and manga english"];

export const muses: GallerySource = {
  name: "8muses",
  match: (url) => /(^|\.)8muses\.com$/.test(url.hostname) && url.pathname.includes("/album/"),
  async fetch(env, url) {
    const res = await fetchPage(env, `${HOST}${url.pathname}`); // www.8muses.com/comics/album/… redirects here
    if (!res.ok) throw new Error(`8muses: ${res.status}`);
    const hits = await scrape(await res.text(), ".top-menu-breadcrumb a", ".gallery a", ".gallery img");
    // Only a leaf album has links to pictures (they end with a number); the others are lists of albums
    const pics = only(hits, ".gallery a").filter((a) => /^\d+$/.test(a.attrs.href?.split("/").pop() ?? ""));
    const thumbs = uniq(only(hits, ".gallery img").map((i) => imgSrc(i.attrs, HOST)).filter((s) => s.includes("/image/th/")));
    if (!pics.length || !thumbs.length) throw new Error("8muses: not an album of pictures");

    const crumbs = only(hits, ".top-menu-breadcrumb a").map((a) => a.text); // [home icon, publisher, author or series, …, title]
    const [, publisher, second, ...rest] = crumbs;
    const publisherKey = publisher?.toLowerCase();
    const isAuthor = WITH_AUTHORS.includes(publisherKey);
    let title = crumbs.at(-1) || null;
    if (rest.length > 1) title = rest.join(" - ");
    else if (second && !isAuthor && title && !title.toLowerCase().startsWith(second.toLowerCase())) title = `${second} - ${title}`;
    // Tags are not on the album page but on its first picture page; the site may not show them
    const picture = await fetchPage(env, new URL(pics[0].attrs.href, HOST).href).then((r) => (r.ok ? r.text() : ""), () => "");
    const siteTags = (await scrape(picture, ".album-tags a[href*='/search/tag']")).map((a) => a.text);
    const circles = publisher && !NOT_PUBLISHERS.includes(publisherKey) ? [publisher] : [];
    const artists = second && isAuthor && rest.length ? [second] : [];
    const series = second && !isAuthor && rest.length ? [second] : [];
    return {
      source: `${HOST}${res.url ? new URL(res.url).pathname : url.pathname}`,
      title,
      tags: uniq([...circles, ...artists, ...series, ...siteTags].map(tagName)),
      data: { title, publisher, circles, artists, series, tags: siteTags, pages: thumbs.length },
      items: thumbs.map((src) => ({ url: new URL(src.replace("/image/th/", "/image/fl/"), HOST).href })), // the large image has the same name as the thumbnail
    };
  },
};
