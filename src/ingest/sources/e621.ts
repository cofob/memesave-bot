import { decrypt } from "../../userkey";
import type { Env } from "../../env";
import { LIMITS } from "../../webapp";
import { fetchPage } from "../fetch";
import type { GallerySource, Item } from "../gallery";

// e621 posts (one meme) and pools (a comic in pool order). API: https://e621.net/wiki_pages/2425

const API = "https://e621.net";
const UA = "memesave/1.0 (e621 importer)"; // generic: never user data
const PAGE = 320; // posts per list page (API maximum)

interface Variant {
  url?: string | null;
  size?: number;
}
export interface Post {
  id: number;
  rating: "s" | "q" | "e";
  file: Variant & { ext: string };
  sample: { url: string | null; alternates?: { samples?: Record<string, Variant>; variants?: { mp4?: Variant } } };
  tags: Record<string, string[]>;
  pools: number[];
}
export interface Pool {
  id: number;
  name: string;
  category: "series" | "collection";
  post_ids: number[];
}

export class E621Error extends Error {
  constructor(readonly status: number) {
    super(`e621 ${status}`); // "429" in the message makes the queue back off
  }
}

export const basic = (username: string, apiKey: string) => `Basic ${btoa(`${username}:${apiKey}`)}`;

/** Authorization header of the user's connected e621 account, if any. */
export async function e621Auth(env: Env, userId?: number) {
  const acc = userId ? await env.DB.prepare("SELECT username, api_key FROM e621_accounts WHERE user_id = ?").bind(userId).first<{ username: string; api_key: string }>() : null;
  return acc ? basic(acc.username, await decrypt(env.ENCRYPTION_KEY, acc.api_key)) : undefined;
}

export const rate = { gap: 500 }; // ms between requests: e621 allows 2 per second
let free = 0; // time of the next free request slot (per isolate)

/** GET of the e621 API as JSON. */
export async function e621Get<T>(env: Env, path: string, auth?: string): Promise<T> {
  const at = Math.max(Date.now(), free);
  free = at + rate.gap;
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
  const res = await fetchPage(env, API + path, { headers: { "User-Agent": UA, ...(auth && { Authorization: auth }) } });
  if (!res.ok) throw new E621Error(res.status);
  return res.json<T>();
}

/** The file to save: a photo or GIF (the sample when the original is too big), an mp4 for a video; null: not importable. */
export function mediaUrl({ file, sample }: Post): string | null {
  if (file.ext === "webm" || file.ext === "mp4") {
    const { samples, variants } = sample.alternates ?? {};
    const all = [samples?.["720p"], samples?.["480p"], variants?.mp4, file.ext === "mp4" ? file : undefined];
    return all.find((v) => v?.url && (v.size ?? 0) <= LIMITS.video)?.url ?? null;
  }
  if (!["jpg", "png", "gif", "webp"].includes(file.ext)) return null; // swf, ...
  return (file.url && file.size! <= LIMITS[file.ext === "gif" ? "animation" : "photo"] ? file.url : sample.url) ?? null;
}

/** An item with the full post as data and every tag category (except invalid) as tags; rating e is porn. */
export const postItem = (p: Post, url: string): Item => ({
  url,
  tags: Object.entries(p.tags).flatMap(([group, tags]) => (group === "invalid" ? [] : tags)),
  data: p,
  porn: p.rating === "e",
});

export const e621: GallerySource = {
  name: "e621",
  headers: { "User-Agent": UA },
  match: (url) => /^(www\.)?e621\.net$/.test(url.hostname) && /^\/(posts|pools)\/\d+/.test(url.pathname),
  async fetch(env, url, _cursor, userId) {
    const [, kind, id] = url.pathname.match(/^\/(posts|pools)\/(\d+)/)!;
    const auth = await e621Auth(env, userId);
    if (kind === "posts") {
      const { post } = await e621Get<{ post: Post }>(env, `/posts/${id}.json`, auth);
      const media = mediaUrl(post);
      return { source: `${API}/posts/${id}`, title: null, items: media ? [postItem(post, media)] : [] };
    }
    const pool = await e621Get<Pool>(env, `/pools/${id}.json`, auth);
    const posts: Post[] = [];
    for (let page = 1, got = PAGE; got === PAGE; page++) {
      const list = await e621Get<{ posts: Post[] }>(env, `/posts.json?${new URLSearchParams({ tags: `pool:${id}`, limit: String(PAGE), page: String(page) })}`, auth);
      posts.push(...list.posts);
      got = list.posts.length;
    }
    // The search order is not the pool order. The pool itself goes into every page's data (its post list is cut).
    const order = new Map(pool.post_ids.map((p, i) => [p, i]));
    const { post_ids, ...info } = pool;
    const items = posts
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .flatMap((p) => {
        const media = mediaUrl(p);
        return media ? [{ ...postItem(p, media), data: { ...p, pool: info } }] : [];
      });
    return { source: `${API}/pools/${id}`, title: pool.name.replaceAll("_", " "), items };
  },
};
