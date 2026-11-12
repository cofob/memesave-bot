import { type Api, InputFile, InputMediaBuilder } from "grammy";
import type { Message } from "grammy/types";
import type { Ctx } from "../bot";
import { botApi } from "../botapi";
import { sha256hex } from "../cache";
import { isAudio, sendPostAudio, setAudio } from "../audio";
import { addToPost } from "../channels";
import { storageFull, type Kind } from "../db";
import type { Env } from "../env";
import { t } from "../i18n";
import { extOf, fileKey, previewKey } from "../media";
import { type Thumb, thumbnail } from "../thumb";
import { extractMedia, insertMeme, type AddedVia, type MemeRow, receiveMedia } from "./receive";

// Media by link: any service of the cobalt API (github.com/imputnet/cobalt, COBALT_URL).

const ALBUM_MAX = 10; // Telegram media group limit
const UPLOAD_MAX = 50 << 20; // Bot API upload limit

export const findLink = (text: string) => text.match(/https?:\/\/\S+/i)?.[0] ?? null;
export interface Item {
  kind: Kind;
  mime: string;
  bytes: Uint8Array;
  thumb?: Thumb; // videos and GIFs: ffmpeg preview and size
  sha256?: string;
}
export interface Fetched {
  source: string;
  items: Item[];
  audio?: { bytes: Uint8Array; mime: string }; // sound of a photo post (TikTok slideshows)
}

const kindOfMime = (mime: string): Kind | null =>
  mime === "image/gif" ? "animation" : mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : null;
const kindOfName = (name = ""): Kind | null =>
  /\.gif$/i.test(name) ? "animation" : /\.(jpe?g|png|webp)$/i.test(name) ? "photo" : /\.(mp4|webm|mov)$/i.test(name) ? "video" : null;

/** Downloads one photo/video/GIF; `hint` is the kind when the server sends no media Content-Type. */
async function download(url: string, hint: Kind | null): Promise<Item> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  if (Number(res.headers.get("Content-Length")) > UPLOAD_MAX) throw new Error(`too large: ${url}`);
  const mime = res.headers.get("Content-Type")?.split(";")[0] ?? "";
  const kind = kindOfMime(mime) ?? hint;
  if (!kind) throw new Error(`not a photo or video: ${mime} ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > UPLOAD_MAX) throw new Error(`too large: ${url}`);
  return { kind, mime: kindOfMime(mime) ? mime : kind === "photo" ? "image/jpeg" : "video/mp4", bytes };
}

/** Downloads the audio of a photo post. */
async function downloadAudio(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  const mime = res.headers.get("Content-Type")?.split(";")[0] || "audio/mpeg";
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!isAudio(mime) || bytes.length > UPLOAD_MAX) throw new Error(`not an audio file: ${mime} ${url}`);
  return { bytes, mime };
}

type CobaltReply = {
  status: string;
  url?: string;
  filename?: string;
  picker?: { type: "photo" | "video" | "gif"; url: string }[];
  audio?: string;
  error?: { code: string };
};

/** Media of `url` from the cobalt API (COBALT_URL, the public instance by default). */
export async function cobalt(env: Env, url: string): Promise<Fetched> {
  const auth: Record<string, string> = env.COBALT_API_KEY ? { Authorization: `Api-Key ${env.COBALT_API_KEY}` } : {};
  const res = await fetch(env.COBALT_URL ?? "https://api.cobalt.tools/", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...auth },
    // 720p keeps videos under the upload limit; GIFs stay mp4 so they fit in albums.
    body: JSON.stringify({ url, videoQuality: "720", convertGif: false }),
  });
  const r = await res.json<CobaltReply>();
  const kinds = { photo: "photo", video: "video", gif: "animation" } as const;
  if (r.picker) {
    const items = await Promise.all(r.picker.map((p) => download(p.url, kinds[p.type])));
    const audio = r.audio && items.some((i) => i.kind === "photo") ? await downloadAudio(r.audio).catch((e) => (console.error("audio download failed", e), undefined)) : undefined;
    return { source: url, items, audio };
  }
  if (r.url) return { source: url, items: [await download(r.url, kindOfName(r.filename))] };
  throw new Error(`cobalt: ${r.error?.code ?? r.status}`);
}

/** The user already has this link (dedupe before the download). */
const linkSaved = (db: D1Database, userId: number, url: string) =>
  db.prepare("SELECT 1 FROM memes WHERE user_id = ? AND status != 'failed' AND source = ?").bind(userId, url).first();

/** Sends the media to a chat: one message, or albums of up to 10 (albums have no GIFs: they go as videos). */
async function sendItems(api: Api, chatId: number, items: Item[], other: { reply_parameters?: { message_id: number }; disable_notification?: boolean }) {
  const file = (it: Item, i: number) => new InputFile(it.bytes, `${i + 1}.${extOf(it.mime)}`);
  // Telegram does not read the size of big videos and shows them as 320x320 squares without a thumbnail.
  const meta = ({ thumb }: Item) =>
    thumb ? { width: thumb.width, height: thumb.height, duration: thumb.duration, thumbnail: new InputFile(new Uint8Array(thumb.jpeg), "thumb.jpg") } : {};
  if (items.length === 1) {
    const [it] = items;
    const f = file(it, 0);
    return [
      it.kind === "photo"
        ? await api.sendPhoto(chatId, f, other)
        : it.kind === "animation"
          ? await api.sendAnimation(chatId, f, { ...other, ...meta(it) })
          : await api.sendVideo(chatId, f, { ...other, ...meta(it), supports_streaming: true }),
    ];
  }
  const media = items.map((it, i) => (it.kind === "photo" ? InputMediaBuilder.photo(file(it, i)) : InputMediaBuilder.video(file(it, i), meta(it))));
  const sent: Message[] = [];
  for (let i = 0; i < media.length; i += ALBUM_MAX) sent.push(...(await api.sendMediaGroup(chatId, media.slice(i, i + ALBUM_MAX), other)));
  return sent;
}

/** One group id for all chunks keeps the order in one post; a single photo with audio gets one too (the audio is on the post). */
const groupOf = (sent: Message[], audio?: Fetched["audio"]) => (sent.length > 1 || audio ? `link:${crypto.randomUUID()}` : undefined);

/** Puts the audio on the post of the group and sends it to the user (so it gets a Telegram file id). */
async function saveAudio(env: Env, api: Api, userId: number, group: string | undefined, audio: Fetched["audio"], other: object) {
  const post = audio && (await env.DB.prepare("SELECT p.id, i.meme_id FROM posts p JOIN post_items i ON i.post_id = p.id WHERE p.user_id = ? AND p.media_group_id = ? LIMIT 1").bind(userId, group).first<{ id: string; meme_id: string }>());
  if (!post) return;
  await setAudio(env, post.id, audio!);
  await sendPostAudio(env, api, userId, post.meme_id, other);
}

/**
 * Items the user does not have yet, by SHA-256 of the downloaded bytes (the same file as an API upload).
 * Telegram may recompress photos, so the hash of these bytes is the one saved.
 */
async function fresh(db: D1Database, userId: number, items: Item[]) {
  const out: Item[] = [];
  for (const it of items) {
    it.sha256 = await sha256hex(it.bytes);
    if (!(await db.prepare("SELECT 1 FROM memes WHERE user_id = ? AND sha256 = ?").bind(userId, it.sha256).first())) out.push(it);
  }
  return out;
}

/** Adds ffmpeg previews to videos and GIFs; without one the item still goes, and a "thumb" job makes it later. */
const withThumbs = (env: Env, userId: number, items: Item[]) =>
  Promise.all(
    items.map(async (it) => {
      if (it.kind !== "photo") it.thumb = await thumbnail(env, userId, it.bytes).catch((e) => (console.error("thumbnail failed", e), undefined));
    }),
  );

/** Keeps the downloaded bytes and the preview in R2: the bot cannot download files over 20 MB from Telegram. */
async function stored(env: Env, it: Item): Promise<Partial<MemeRow>> {
  const base = `link/${crypto.randomUUID().replaceAll("-", "")}`;
  const row = { r2_file: fileKey(base, it.mime), sha256: it.sha256 };
  await env.MEDIA.put(row.r2_file, it.bytes, { httpMetadata: { contentType: it.mime } });
  if (!it.thumb) return row;
  const { jpeg, ...size } = it.thumb;
  await env.MEDIA.put(previewKey(base), jpeg, { httpMetadata: { contentType: "image/jpeg" } });
  return { ...row, ...size, r2_preview: previewKey(base) };
}

/** Downloads media of a link, sends it to the user and saves it like forwarded media; an album becomes one post. */
export async function importLink(ctx: Ctx, env: Env, url: string) {
  const html = { parse_mode: "HTML" } as const;
  try {
    if (await linkSaved(env.DB, ctx.user.id, url)) return ctx.reply(t(ctx.lang, "already_saved"), html);
    await ctx.replyWithChatAction("upload_video").catch(() => {});
    const { source, items: all, audio } = await cobalt(env, url);
    const items = await fresh(env.DB, ctx.user.id, all);
    if (!items.length) return ctx.reply(t(ctx.lang, "already_saved"), html);
    await withThumbs(env, ctx.user.id, items);
    const reply = { reply_parameters: { message_id: ctx.msg!.message_id } };
    const sent = await sendItems(ctx.api, ctx.chat!.id, items, reply);
    const group = groupOf(sent, audio);
    for (const [i, msg] of sent.entries()) {
      await receiveMedia(ctx, env, msg, { source, mediaGroupId: group, position: i, row: await stored(env, items[i]) });
    }
    await saveAudio(env, ctx.api, ctx.user.id, group, audio, reply);
  } catch (e) {
    console.error("link import failed", url, e);
    return ctx.reply(t(ctx.lang, "link_failed"), html);
  }
}

/** Queue job of the API import: like importLink, but silent and without status messages. */
export async function linkJob(env: Env, userId: number, url: string, via: AddedVia = "api") {
  if (await linkSaved(env.DB, userId, url)) return;
  const { source, items: all, audio } = await cobalt(env, url);
  const items = await fresh(env.DB, userId, all);
  if (!items.length || (await storageFull(env.DB, userId))) return;
  await withThumbs(env, userId, items);
  const api = botApi(env.BOT_TOKEN);
  const sent = await sendItems(api, userId, items, { disable_notification: true });
  const group = groupOf(sent, audio);
  for (const [i, msg] of sent.entries()) {
    const memeId = await insertMeme(env.DB, userId, { ...extractMedia(msg)!, caption: null, source, import_id: null, added_via: via, ...(await stored(env, items[i])) });
    if (!memeId) continue;
    await addToPost(env.DB, userId, { memeId, mediaGroupId: group, position: i });
    await env.JOBS.send({ type: items[i].kind === "photo" || items[i].thumb ? "embed" : "thumb", memeId });
  }
  await saveAudio(env, api, userId, group, audio, { disable_notification: true });
}
