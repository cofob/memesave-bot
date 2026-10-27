import { InputFile, type Api } from "grammy";
import type { InlineQueryResult, Message } from "grammy/types";
import type { Meme } from "../db";
import type { Env } from "../env";
import { t, type Lang } from "../i18n";
import { extractMedia } from "../ingest/receive";
import { memeMedia, signedMediaUrl, variantOf } from "../media";

const URL_TTL = 86400;
const EXT: Record<string, string> = { "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/webm": "webm", "video/quicktime": "mov" };

/** Inline result: by Telegram file_id first; memes not yet in Telegram use signed R2 URLs (null when impossible). */
export async function toInlineResult(env: Env, m: Meme): Promise<InlineQueryResult | null> {
  if (m.file_id) {
    if (m.kind === "photo") return { type: "photo", id: m.id, photo_file_id: m.file_id };
    if (m.kind === "video") {
      return { type: "video", id: m.id, video_file_id: m.file_id, title: m.title ?? "Video", description: m.tags?.split("\n").slice(0, 5).join(", ") };
    }
    return m.mime === "video/mp4" ? { type: "mpeg4_gif", id: m.id, mpeg4_file_id: m.file_id } : { type: "gif", id: m.id, gif_file_id: m.file_id };
  }
  const url = await signedMediaUrl(env, m, "file", URL_TTL);
  const thumb = variantOf(m, "preview") === "preview" ? await signedMediaUrl(env, m, "preview", URL_TTL) : null;
  if (m.kind === "photo") return { type: "photo", id: m.id, photo_url: url, thumbnail_url: thumb ?? url };
  if (m.kind === "video") {
    // Telegram needs a JPEG thumbnail for URL videos.
    return thumb ? { type: "video", id: m.id, video_url: url, mime_type: "video/mp4", thumbnail_url: thumb, title: m.title ?? "Video" } : null;
  }
  return thumb
    ? { type: "mpeg4_gif", id: m.id, mpeg4_url: url, thumbnail_url: thumb }
    : { type: "mpeg4_gif", id: m.id, mpeg4_url: url, thumbnail_url: url, thumbnail_mime_type: "video/mp4" };
}

/** A video file id without Telegram's thumbnail: it was uploaded without the size and shows as a square. */
const stale = (m: Meme) => m.kind !== "photo" && !!m.file_id && !m.preview_file_id && !!m.r2_file && !!m.r2_preview;

/** Size, duration and thumbnail of an uploaded video: Telegram does not read them from big videos. */
async function videoMeta(env: Env, m: Meme) {
  if (m.kind === "photo") return {};
  const thumb = m.r2_preview ? new InputFile(new Uint8Array((await memeMedia(env, m, "preview")).bytes), "thumb.jpg") : undefined;
  return { width: m.width ?? undefined, height: m.height ?? undefined, duration: m.duration ?? undefined, thumbnail: thumb };
}

/** Telegram input: the file_id first; the R2 copy (with its meta) when there is none, it is stale or `upload` is set. */
async function input(env: Env, m: Meme, upload = false) {
  if (m.file_id && !upload && !stale(m)) return { file: m.file_id, meta: {} };
  const media = await memeMedia(env, m, "file");
  const ext = EXT[media.mime] ?? (m.kind === "photo" ? "jpg" : "mp4");
  return { file: new InputFile(new Uint8Array(media.bytes), `${m.id}.${ext}`), meta: await videoMeta(env, m) };
}

/** After an upload from R2: keep Telegram's file ids for the next sends. The R2 copy stays. */
async function adopt(env: Env, m: Meme, msg: Message) {
  const sent = extractMedia(msg);
  if (!sent) return;
  try {
    await env.DB.prepare("UPDATE memes SET file_id = ?, file_unique_id = ?, preview_file_id = ?, preview_unique_id = ? WHERE id = ?")
      .bind(sent.file_id, sent.file_unique_id, sent.preview_file_id, sent.preview_unique_id, m.id)
      .run();
  } catch (e) {
    console.warn("file ids not saved", m.id, e); // e.g. the user already has this Telegram file
  }
}

/** Sends with file ids; if Telegram rejects one (or there is none), uploads the R2 copies and keeps the new ids. */
async function withUploadFallback<T>(env: Env, memes: Meme[], send: (upload: boolean) => Promise<T>, sent: (result: T) => Message[]) {
  const needsUpload = memes.some((m) => !m.file_id || stale(m));
  try {
    const result = await send(needsUpload);
    if (needsUpload) await Promise.all(sent(result).map((msg, i) => adopt(env, memes[i], msg)));
  } catch (e) {
    if (needsUpload || !memes.every((m) => m.r2_file)) throw e;
    console.warn("file_id send failed, uploading from R2", e);
    const result = await send(true);
    await Promise.all(sent(result).map((msg, i) => adopt(env, memes[i], msg)));
  }
}

/** Sends one meme to a chat. */
export async function sendMeme(env: Env, api: Api, chatId: number, m: Meme, other: object = {}) {
  await withUploadFallback(
    env,
    [m],
    async (upload) => {
      const { file, meta } = await input(env, m, upload);
      return m.kind === "photo"
        ? api.sendPhoto(chatId, file, other)
        : m.kind === "video"
          ? api.sendVideo(chatId, file, { ...other, ...meta, supports_streaming: true })
          : api.sendAnimation(chatId, file, { ...other, ...meta });
    },
    (msg) => [msg],
  );
}

/** Sends search results as replies to the query: photo/video albums, then GIFs one by one. */
export async function sendResults(env: Env, api: Api, chatId: number, replyTo: number, memes: Meme[], lang: Lang) {
  const reply = { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };
  if (!memes.length) return api.sendMessage(chatId, t(lang, "nothing_found"), { ...reply, parse_mode: "HTML" });

  await sendAlbum(env, api, chatId, memes, reply);
}

/**
 * Sends memes in order: photos and videos as albums of up to 10, then GIFs one by one (albums cannot hold GIFs).
 * `caption` goes on the first message.
 */
export async function sendAlbum(env: Env, api: Api, chatId: number, memes: Meme[], other: object = {}, caption?: string) {
  const album = memes.filter((m) => m.kind !== "animation");
  let first = caption ? { caption } : {};
  for (let i = 0; i < album.length; i += 10) {
    const chunk = album.slice(i, i + 10);
    const extra = first;
    first = {};
    if (chunk.length === 1) {
      await sendMeme(env, api, chatId, chunk[0], { ...other, ...extra });
      continue;
    }
    await withUploadFallback(
      env,
      chunk,
      async (upload) => {
        const media = await Promise.all(
          chunk.map(async (m, j) => {
            const { file, meta } = await input(env, m, upload && !!m.r2_file);
            return { type: m.kind === "photo" ? "photo" : "video", media: file, ...meta, ...(j ? {} : extra) } as const;
          }),
        );
        return api.sendMediaGroup(chatId, media, other);
      },
      (msgs) => msgs,
    );
  }
  for (const m of memes.filter((m) => m.kind === "animation")) {
    await sendMeme(env, api, chatId, m, { ...other, ...first });
    first = {};
  }
}
