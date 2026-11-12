import { botApi } from "../botapi";
import { sha256hex } from "../cache";
import { getUser, userLang, type User } from "../db";
import type { Env } from "../env";
import { esc, t, type Lang } from "../i18n";
import { saveUpload } from "../webapp";
import { editWidget, progressApi, sendWidget } from "../widget";
import { progressPage } from "../widgetpages";
import { linkSaved } from "./link";
import type { AddedVia } from "./receive";
import { scraper } from "./scraper";

// Import of galleries (comics, albums) by link. A listing of items, then downloads in chunks over queue jobs.
// The state lives in R2 (a gallery can have thousands of items), not in the queue message.

/** An image: `url`, or a `page` that the source resolves to the image URL (e.g. E-Hentai). Tags and data are of this item only. */
export type Item = ({ url: string } | { page: string }) & { tags?: string[]; data?: unknown; porn?: boolean };

/** One listing step. `source` is the canonical URL (dedupe); title, tags and data are taken from the first step. */
export interface Listing {
  site: string; // site name in source_meta
  source: string;
  title: string | null;
  tags?: string[]; // of the whole gallery, saved on every page
  data?: unknown; // full source object, saved on every page (source_meta)
  items: Item[];
  next?: string; // cursor of the next step; a step may fetch ~20 pages of the site
  headers?: Record<string, string>; // for image downloads (Referer)
}

export interface GallerySource {
  name: string;
  match(url: URL): boolean;
  fetch(env: Env, url: URL, cursor?: string, userId?: number): Promise<Listing>; // userId: for sources with the user's account
  download(env: Env, item: Item, site: string, headers?: Record<string, string>): Promise<Response>; // the image of an item
}

/** All gallery sources: a new source adds its line here. */
export const SOURCES: GallerySource[] = [scraper];

/** The source of a link, if any. */
export const gallerySource = (link: string) => {
  const url = URL.canParse(link) ? new URL(link) : null;
  return url && SOURCES.find((s) => s.match(url));
};

const CHUNK = 10; // items per job (D1 and R2 operations per invocation)
const JOB_MS = 60_000; // a job of a slow site stops after it, the rest goes to the next job: the queue serves the other jobs in between
const RETRY_DELAYS = [60, 300, 900]; // s before each retry pass over the pages that failed for a transient reason (3 retries at most)
const PAGES_SHOWN = 50; // page numbers in the report of missing pages
const EXT_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm" };
const mimeOf = (url: string, header: string) => (/^(image|video)\//.test(header) ? header : (EXT_MIME[new URL(url).pathname.split(".").pop()!.toLowerCase()] ?? header));

export interface SaveOpts {
  src: GallerySource;
  site: string; // site name in source_meta
  headers?: Record<string, string>; // for image downloads
  source: string; // canonical URL
  via: AddedVia;
  caption?: string | null;
  post?: { mediaGroupId: string; position: number; layout?: "comic" }; // without it a single meme of any kind
  tags?: string[]; // gallery level, with the tags of the item
  data?: unknown; // gallery level, replaced by the data of the item
}

/** Why a page is missing: HTTP 4xx or out of retries, not an image or video, too large or rejected. */
type Reason = "download" | "photo" | "rejected";

/** A page that cannot be downloaded at all (HTTP 4xx): no retry. Other errors (network, 408/425/429/5xx, resolve) are transient. */
class Permanent extends Error {}
const transient = (status: number) => [408, 425, 429].includes(status) || status >= 500;

/** Downloads one item and saves it as a meme. A comic page is an image, GIF or video (videos get a preview in the thumb job); "full": the storage limit is reached. */
export async function saveItem(env: Env, user: User, item: Item, o: SaveOpts): Promise<"saved" | "full" | Exclude<Reason, "download">> {
  const url = "url" in item ? item.url : item.page;
  const res = await o.src.download(env, item, o.site, o.headers);
  if (!res.ok) throw new (transient(res.status) ? Error : Permanent)(`download ${res.status} ${url}`);
  const type = mimeOf(url, res.headers.get("Content-Type")?.split(";")[0] ?? "");
  if (o.post && !/^(image|video)\//.test(type)) return console.warn("gallery: not media, skipped", url, type), "photo";
  const sourceMeta = { site: o.site, tags: [...(o.tags ?? []), ...(item.tags ?? [])], data: item.data ?? o.data, porn: item.porn };
  const saved = await saveUpload(env, user, new File([await res.arrayBuffer()], "page", { type }), { via: o.via, source: o.source, caption: o.caption, post: o.post, sourceMeta });
  if (!("error" in saved)) return "saved";
  console.warn("gallery: not saved", url, saved.error);
  return saved.status === 507 ? "full" : "rejected";
}

interface State {
  userId: number;
  url: string;
  via: AddedVia;
  chatId?: number;
  listing: boolean; // the listing is not done yet
  site?: string; // set by the first listing step
  headers?: Record<string, string>;
  source?: string;
  title: string | null;
  tags?: string[];
  data?: unknown;
  items: Item[];
  next?: string;
  done?: number; // progress widget: saved pages
  missing?: { position: number; reason: Reason }[]; // pages that finally failed
  round?: number; // retry pass (0 = the main pass); it goes over `retry`
  retry?: number[]; // positions to download in this retry pass
  failed?: number[]; // positions that failed for a transient reason in this pass
  widget?: number; // message id of the progress widget, 0 = Telegram refused it
  edited?: number; // ms of its last edit
}

const stateKey = (importId: string) => `tmp/gallery/${importId}.json`; // "tmp/" expires, so a lost job leaves no garbage
const next = (env: Env, importId: string, from: number, delaySeconds?: number) => env.JOBS.send({ type: "gallery", importId, from }, { delaySeconds });

/** Bot message to the chat of the import (silent without one: the web app). */
async function notify(env: Env, st: State, key: Parameters<typeof t>[1], params: Parameters<typeof t>[2] = {}) {
  if (!st.chatId) return;
  await botApi(env.BOT_TOKEN).sendMessage(st.chatId, t(await userLang(env.DB, st.userId), key, params), { parse_mode: "HTML" }).catch(console.error);
}

/** A single e621 post of a pool: buttons to import the pool as a comic (src/e621bot.ts handles them). */
async function offerPools(env: Env, st: State, site?: string, item?: Item) {
  const pools = site === "e621" ? ((item?.data as { pools?: number[] } | undefined)?.pools ?? []) : [];
  if (!st.chatId || !pools.length) return;
  const lang = await userLang(env.DB, st.userId);
  const button = (id: number) => [{ text: t(lang, pools.length > 1 ? "e621_btn_pool_n" : "e621_btn_pool", { id }), callback_data: `e621:pool:${id}` }];
  await botApi(env.BOT_TOKEN).sendMessage(st.chatId, t(lang, "e621_pool_offer"), { parse_mode: "HTML", reply_markup: { inline_keyboard: pools.slice(0, 5).map(button) } }).catch(console.error);
}

const big = (st: State) => st.widget !== undefined || !!st.next || st.items.length > CHUNK; // a big gallery shows a progress widget

/** The progress widget: sent once, then edited silently at most once per 8 s (`end`: always); false when there is none (no chat, or Telegram refuses it). */
async function progress(env: Env, st: State, end = false) {
  if (!st.chatId || st.widget === 0) return false;
  const now = Date.now();
  if (st.widget && !end && now - (st.edited ?? 0) < 8000) return true;
  const state = JSON.stringify({ f: st.items.length, t: st.listing ? 0 : st.items.length, d: st.done ?? 0, k: st.missing?.length ?? 0, e: end ? 1 : undefined });
  if (st.widget) await editWidget(end ? botApi(env.BOT_TOKEN) : progressApi(env.BOT_TOKEN), st.chatId, st.widget, state).catch(console.error);
  else {
    const lang = await userLang(env.DB, st.userId);
    const sent = await sendWidget(botApi(env.BOT_TOKEN), {
      chat_id: st.chatId,
      html: progressPage(lang, "w_comic_saving", "w_comic_skipped"),
      caption: t(lang, "w_comic_caption", { title: esc(st.title ?? st.source!) }),
      parse_mode: "HTML",
      chat_data: state,
    });
    st.widget = sent?.message_id ?? 0;
    if (!sent) return false;
  }
  st.edited = now;
  return true;
}

/** [5, 17, 18, 19] → "5, 17–19"; at most PAGES_SHOWN numbers, then "…". */
export function pageRanges(pages: number[]) {
  const shown = pages.slice(0, PAGES_SHOWN);
  const out: string[] = [];
  for (let i = 0, j = 0; i < shown.length; i = ++j) {
    while (shown[j + 1] === shown[j] + 1) j++;
    out.push(j > i ? `${shown[i]}–${shown[j]}` : `${shown[i]}`);
  }
  return out.join(", ") + (pages.length > PAGES_SHOWN ? ", …" : "");
}

/** The missing pages (1-based) grouped by reason. */
const missingLines = (lang: Lang, missing: NonNullable<State["missing"]>) =>
  (["download", "photo", "rejected"] as const)
    .map((r) => [r, missing.filter((m) => m.reason === r).map((m) => m.position + 1).sort((a, b) => a - b)] as const)
    .filter(([, pages]) => pages.length)
    .map(([r, pages]) => t(lang, `comic_missing_${r}`, { pages: pageRanges(pages) }))
    .join("\n");

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
      if (await linkSaved(env.DB, st.userId, l.source)) return (await fail("already_saved"), offerPools(env, st, l.site, l.items.length === 1 ? l.items[0] : undefined));
      Object.assign(st, { site: l.site, headers: l.headers, source: l.source, title: l.title, tags: l.tags, data: l.data });
    }
    st.items.push(...l.items);
    st.next = l.next;
    if (!st.next && !st.items.length) return fail("link_failed");
    st.listing = !!st.next;
    const shown = big(st) && (await progress(env, st));
    await env.MEDIA.put(stateKey(importId), JSON.stringify(st));
    if (!st.listing && st.items.length > 1 && !shown) await notify(env, st, "comic_saving", { title: esc(st.title ?? st.source!), n: st.items.length });
    return next(env, importId, 0);
  }

  const user = await getUser(env.DB, st.userId);
  if (!user) return end();
  const single = st.items.length === 1; // one image is a normal meme
  const mediaGroupId = `gallery:${await sha256hex(st.source!)}`;
  const positions = st.round ? st.retry! : st.items.map((_, i) => i);
  const started = Date.now();
  let i = from;
  for (; i < Math.min(from + CHUNK, positions.length) && (i === from || Date.now() - started < JOB_MS); i++) {
    const position = positions[i];
    const post = single ? undefined : { mediaGroupId, position, layout: "comic" as const };
    try {
      const r = await saveItem(env, user, st.items[position], { src, site: st.site!, headers: st.headers, source: st.source!, via: st.via, caption: position === 0 ? st.title : null, post, tags: st.tags, data: st.data });
      if (r === "full") return fail("storage_full");
      if (r === "saved") st.done = (st.done ?? 0) + 1;
      else (st.missing ??= []).push({ position, reason: r });
    } catch (e) {
      console.error("gallery page failed", st.url, position, e);
      if (e instanceof Permanent) (st.missing ??= []).push({ position, reason: "download" });
      else (st.failed ??= []).push(position); // retried after a delay
    }
  }
  if (i < positions.length) {
    await progress(env, st); // a gallery with more than one chunk is big
    await env.MEDIA.put(stateKey(importId), JSON.stringify(st));
    return next(env, importId, i);
  }
  const failed = st.failed ?? [];
  const wait = RETRY_DELAYS[st.round ?? 0];
  if (failed.length && wait) {
    Object.assign(st, { round: (st.round ?? 0) + 1, retry: failed, failed: [] });
    await env.MEDIA.put(stateKey(importId), JSON.stringify(st));
    return next(env, importId, 0, wait);
  }
  (st.missing ??= []).push(...failed.map((position) => ({ position, reason: "download" as const }))); // out of retries
  await end();
  const shown = !single && big(st) && (await progress(env, st, true));
  if (st.missing.length) {
    console.warn("gallery: missing pages", st.url, st.missing.map((m) => `${m.position + 1}:${m.reason}`).join(" "));
    const lang = await userLang(env.DB, st.userId);
    await notify(env, st, "comic_missing", { title: esc(st.title ?? st.source!), saved: st.done ?? 0, n: st.items.length, lines: missingLines(lang, st.missing) });
  } else if (!single && !shown) await notify(env, st, "comic_saved", { title: esc(st.title ?? st.source!), n: st.items.length });
  if (single) await offerPools(env, st, st.site, st.items[0]);
}
