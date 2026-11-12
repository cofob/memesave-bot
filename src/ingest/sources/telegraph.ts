import { fetchPage } from "../fetch";
import type { GallerySource } from "../gallery";

// Telegraph pages (telegra.ph): the images of the article in order.

type Node = string | { tag: string; attrs?: { src?: string }; children?: Node[] };
interface Page {
  ok: boolean;
  error?: string;
  result?: { title: string; author_name?: string; author_url?: string; description?: string; content?: Node[] };
}

const images = (nodes: Node[] = []): string[] =>
  nodes.flatMap((n) => (typeof n === "string" ? [] : n.tag === "img" && n.attrs?.src ? [n.attrs.src] : images(n.children)));

export const telegraph: GallerySource = {
  name: "telegraph",
  match: (url) => ["telegra.ph", "graph.org"].includes(url.hostname) && /^\/[^/]+\/?$/.test(url.pathname),
  async fetch(env, url) {
    const slug = url.pathname.replace(/^\/|\/$/g, "");
    const page = await (await fetchPage(env, `https://api.telegra.ph/getPage/${slug}?return_content=true`)).json<Page>();
    if (!page.ok || !page.result) throw new Error(`telegraph: ${page.error}`);
    const { title, author_name, author_url, description, content } = page.result;
    return {
      source: `https://telegra.ph/${slug}`,
      title,
      data: { title, author_name, author_url, description },
      items: images(content).map((src) => ({ url: new URL(src, "https://telegra.ph").href })), // /file/… is relative
    };
  },
};
