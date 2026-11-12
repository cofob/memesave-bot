// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: KemonoContent.kt, KemonoParser.kt.
import type { Env } from "../../env";
import { fetchPage } from "../fetch";
import type { GallerySource, Item, Listing } from "../gallery";
import { tagName, uniq } from "./html";

const SITE = "https://kemono.cr";
const PAGE = 50; // posts per API call
const CALLS_PER_STEP = 20;
const IMAGE = /\.(jpe?g|png|webp|gif)$/i;

interface Post {
  id: string;
  user: string;
  service: string;
  title: string;
  content?: string;
  published?: string;
  edited?: string;
  file?: { name?: string; path?: string };
  attachments?: { name: string; path: string }[];
  tags?: string[] | null;
}
interface Profile {
  id: string;
  name: string;
  service: string;
  post_count?: number;
  indexed?: string;
  updated?: string;
}

/** API call; DDoS-Guard lets `Accept: text/css` through. */
async function api<T>(env: Env, path: string): Promise<T> {
  const res = await fetchPage(env, `${SITE}/api/v1/${path}`, { headers: { Accept: "text/css" } });
  if (!res.ok) throw new Error(`kemono: ${res.status} ${path}`);
  return res.json<T>();
}

/** The image URLs of a post: the main file and the attachments (the file is usually among them). */
const images = (p: Post) => uniq([p.file?.path, ...(p.attachments ?? []).map((a) => a.path)]).filter((s) => IMAGE.test(s)).map((path) => `${SITE}/data${path}`);

const postData = (p: Post) => ({ id: p.id, title: p.title, published: p.published, edited: p.edited, tags: p.tags, content: p.content?.slice(0, 2000) });

export const kemono: GallerySource = {
  name: "kemono",
  headers: { Referer: `${SITE}/` },
  match: (url) => /(^|\.)kemono\.(cr|su|party)$/.test(url.hostname) && /^\/[^/]+\/user\/[^/]+(\/post\/[^/]+)?\/?$/.test(url.pathname),
  async fetch(env, url, cursor) {
    const [service, , user, , postId] = url.pathname.split("/").filter(Boolean);
    const base = `${service}/user/${user}`;
    if (postId) return post(env, base, postId);
    return creator(env, base, cursor);
  },
};

/** One post is one gallery. */
async function post(env: Env, base: string, id: string): Promise<Listing> {
  const [{ post: p }, profile] = await Promise.all([api<{ post: Post }>(env, `${base}/post/${id}`), api<Profile>(env, `${base}/profile`)]);
  return {
    source: `${SITE}/${base}/post/${id}`,
    title: p.title,
    tags: uniq([profile.name, profile.service, ...(p.tags ?? [])].map(tagName)),
    data: { creator: profile, post: postData(p) },
    items: images(p).map((url) => ({ url })),
  };
}

/** All posts of a creator are one comic, the oldest first: the offsets go from the last one to 0, the cursor is the next offset. */
async function creator(env: Env, base: string, cursor?: string): Promise<Listing> {
  const first = cursor === undefined;
  const profile = first ? await api<Profile>(env, `${base}/profile`) : undefined;
  let offset = first ? Math.max(0, Math.ceil((profile!.post_count ?? 0) / PAGE) - 1) * PAGE : +cursor;
  const items: Item[] = [];
  for (let n = 0; n < CALLS_PER_STEP && offset >= 0; n++, offset -= PAGE) {
    const posts = await api<Post[]>(env, `${base}/posts?o=${offset}`);
    for (const p of posts.reverse()) items.push(...images(p).map((url) => ({ url, tags: p.tags?.map(tagName), data: { creator: { id: p.user, service: p.service }, post: postData(p) } })));
  }
  return {
    source: `${SITE}/${base}`,
    title: profile?.name ?? null,
    tags: profile && uniq([profile.name, profile.service].map(tagName)),
    data: profile && { creator: profile },
    items,
    next: offset >= 0 ? String(offset) : undefined,
  };
}
