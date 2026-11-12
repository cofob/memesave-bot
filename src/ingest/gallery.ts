import { botApi } from "../botapi";
import { sha256hex } from "../cache";
import { getUser, userLang, type User } from "../db";
import type { Env } from "../env";
import { esc, t } from "../i18n";
import { saveUpload } from "../webapp";
import { fetchMedia } from "./fetch";
import { linkSaved } from "./link";
import type { AddedVia } from "./receive";
import { allporncomic } from "./sources/allporncomic";
import { asmhentai } from "./sources/asmhentai";
import { e621 } from "./sources/e621";
import { ehentai } from "./sources/ehentai";
import { hentaifox } from "./sources/hentaifox";
import { hitomi } from "./sources/hitomi";
import { imhentai } from "./sources/imhentai";
import { kemono } from "./sources/kemono";
import { muses } from "./sources/muses";
import { multporn } from "./sources/multporn";
import { nhentai } from "./sources/nhentai";
import { telegraph } from "./sources/telegraph";

// Import of galleries (comics, albums) by link. A listing of items, then downloads in chunks over queue jobs.
// The state lives in R2 (a gallery can have thousands of items), not in the queue message.

/** An image: `url`, or a `page` that the source resolves to the image URL (e.g. E-Hentai). Tags and data are of this item only. */
export type Item = ({ url: string } | { page: string }) & { tags?: string[]; data?: unknown; porn?: boolean };

/** One listing step. `source` is the canonical URL (dedupe); title, tags and data are taken from the first step. */
export interface Listing {
  source: string;
  title: string | null;
  tags?: string[]; // of the whole gallery, saved on every page
  data?: unknown; // full source object, saved on every page (source_meta)
  items: Item[];
  next?: string; // cursor of the next step; a step may fetch ~20 pages of the site
}

export interface GallerySource {
  name: string; // site name in source_meta
  match(url: URL): boolean;
  fetch(env: Env, url: URL, cursor?: string, userId?: number): Promise<Listing>; // userId: for sources with the user's account
  resolve?(env: Env, page: string): Promise<string>; // image URL of a `{ page }` item
  headers?: Record<string, string>; // for image downloads (Referer)
}

/** All gallery sources: a new source adds its line here. */
export const SOURCES: GallerySource[] = [telegraph, e621, nhentai, ehentai, hitomi, imhentai, hentaifox, asmhentai, muses, multporn, allporncomic, kemono];

/** The source of a link, if any. */
export const gallerySource = (link: string) => {
  const url = URL.canParse(link) ? new URL(link) : null;
  return url && SOURCES.find((s) => s.match(url));
};

const CHUNK = 10; // items per job (D1 and R2 operations per invocation)
const EXT_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm" };
const mimeOf = (url: string, header: string) => (/^(image|video)\//.test(header) ? header : (EXT_MIME[new URL(url).pathname.split(".").pop()!.toLowerCase()] ?? header));

export interface SaveOpts {
  src: GallerySource;
  source: string; // canonical URL
  via: AddedVia;
  caption?: string | null;
  post?: { mediaGroupId: string; position: number; layout?: "comic" }; // without it a single meme of any kind
  tags?: string[]; // gallery level, with the tags of the item
  data?: unknown; // gallery level, replaced by the data of the item
}

/** Downloads one item and saves it as a meme. A comic page must be a photo; "full": the storage limit is reached. */
export async function saveItem(env: Env, user: User, item: Item, o: SaveOpts): Promise<"saved" | "skipped" | "full"> {
  const url = "url" in item ? item.url : await o.src.resolve!(env, item.page);
  const res = await fetchMedia(env, url, { headers: o.src.headers }, user.id);
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  const type = mimeOf(url, res.headers.get("Content-Type")?.split(";")[0] ?? "");
  if (o.post && (!type.startsWith("image/") || type === "image/gif")) return console.warn("gallery: not a photo, skipped", url, type), "skipped";
  const sourceMeta = { site: o.src.name, tags: [...(o.tags ?? []), ...(item.tags ?? [])], data: item.data ?? o.data, porn: item.porn };
  const saved = await saveUpload(env, user, new File([await res.arrayBuffer()], "page", { type }), { via: o.via, source: o.source, caption: o.caption, post: o.post, sourceMeta });
  if (!("error" in saved)) return "saved";
  console.warn("gallery: not saved", url, saved.error);
  return saved.status === 507 ? "full" : "skipped";
}

interface State {
  userId: number;
  url: string;
  via: AddedVia;
  chatId?: number;
  listing: boolean; // the listing is not done yet
  source?: string; // set by the first listing step
  title: string | null;
  tags?: string[];
  data?: unknown;
  items: Item[];
  next?: string;
}

const stateKey = (importId: string) => `tmp/gallery/${importId}.json`; // "tmp/" expires, so a lost job leaves no garbage
const next = (env: Env, importId: string, from: number) => env.JOBS.send({ type: "gallery", importId, from });

/** Bot message to the chat of the import (silent without one: the web app). */
async function notify(env: Env, st: State, key: Parameters<typeof t>[1], params: Parameters<typeof t>[2] = {}) {
  if (!st.chatId) return;
  await botApi(env.BOT_TOKEN).sendMessage(st.chatId, t(await userLang(env.DB, st.userId), key, params), { parse_mode: "HTML" }).catch(console.error);
}

/** Starts the import of a gallery link in the background. */
export async function startGallery(env: Env, userId: number, url: string, via: AddedVia, chatId?: number) {
  const importId = crypto.randomUUID().replaceAll("-", "");
  const st: State = { userId, url, via, chatId, listing: true, title: null, items: [] };
  await env.MEDIA.put(stateKey(importId), JSON.stringify(st));
  await next(env, importId, 0);
}

/** Queue job: one listing step, or one chunk of downloads; it queues the next one. The state is deleted at the end. */
export async function galleryJob(env: Env, importId: string, from: number) {
  const obj = await env.MEDIA.get(stateKey(importId));
  if (!obj) return; // finished or failed before
  const st = await obj.json<State>();
  const end = () => env.MEDIA.delete(stateKey(importId));
  const fail = async (key: Parameters<typeof t>[1]) => (await notify(env, st, key), end());
  const src = gallerySource(st.url)!;

  if (st.listing) {
    const first = st.source === undefined;
    let l: Listing;
    try {
      l = await src.fetch(env, new URL(st.url), st.next, st.userId);
    } catch (e) {
      if (!first) throw e; // the queue repeats the step
      console.error("gallery listing failed", st.url, e);
      return fail("link_failed");
    }
    if (first) {
      if (await linkSaved(env.DB, st.userId, l.source)) return fail("already_saved");
      Object.assign(st, { source: l.source, title: l.title, tags: l.tags, data: l.data });
    }
    st.items.push(...l.items);
    st.next = l.next;
    if (!st.next && !st.items.length) return fail("link_failed");
    st.listing = !!st.next;
    await env.MEDIA.put(stateKey(importId), JSON.stringify(st));
    if (!st.listing && st.items.length > 1) await notify(env, st, "comic_saving", { title: esc(st.title ?? st.source!), n: st.items.length });
    return next(env, importId, 0);
  }

  const user = await getUser(env.DB, st.userId);
  if (!user) return end();
  const single = st.items.length === 1; // one image is a normal meme
  const mediaGroupId = `gallery:${await sha256hex(st.source!)}`;
  for (const [i, item] of st.items.slice(from, from + CHUNK).entries()) {
    const position = from + i;
    const post = single ? undefined : { mediaGroupId, position, layout: "comic" as const };
    try {
      const r = await saveItem(env, user, item, { src, source: st.source!, via: st.via, caption: position === 0 ? st.title : null, post, tags: st.tags, data: st.data });
      if (r === "full") return fail("storage_full");
    } catch (e) {
      console.error("gallery page failed", st.url, position, e); // the page is skipped
    }
  }
  if (from + CHUNK < st.items.length) return next(env, importId, from + CHUNK);
  await end();
  if (!single) await notify(env, st, "comic_saved", { title: esc(st.title ?? st.source!), n: st.items.length });
}
