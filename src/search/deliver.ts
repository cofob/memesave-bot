import { InputFile, type Api } from "grammy";
import type { InlineQueryResult, Message } from "grammy/types";
import type { Meme } from "../db";
import type { Env } from "../env";
import { t, type Lang } from "../i18n";
import { extractMedia } from "../ingest/receive";
import { getMedia, isStored, signedMediaUrl, storedKey } from "../media";

const URL_TTL = 86400;
const EXT: Record<string, string> = { "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/webm": "webm", "video/quicktime": "mov" };

/** Inline result: by file_id, or by signed URL for imported memes not yet in Telegram (null when impossible). */
export async function toInlineResult(env: Env, m: Meme): Promise<InlineQueryResult | null> {
  if (!isStored(m.file_unique_id)) {
    if (m.kind === "photo") return { type: "photo", id: m.id, photo_file_id: m.file_id };
    if (m.kind === "video") {
      return { type: "video", id: m.id, video_file_id: m.file_id, title: m.title ?? "Video", description: m.tags?.split("\n").slice(0, 5).join(", ") };
    }
    return m.mime === "video/mp4" ? { type: "mpeg4_gif", id: m.id, mpeg4_file_id: m.file_id } : { type: "gif", id: m.id, gif_file_id: m.file_id };
  }
  const url = await signedMediaUrl(env, m.file_unique_id, URL_TTL, m.mime ?? (m.kind === "photo" ? "image/jpeg" : "video/mp4"));
  const thumb = m.preview_unique_id ? await signedMediaUrl(env, m.preview_unique_id, URL_TTL) : null;
  if (m.kind === "photo") return { type: "photo", id: m.id, photo_url: url, thumbnail_url: thumb ?? url };
  if (m.kind === "video") {
    // Telegram needs a JPEG thumbnail for URL videos.
    return thumb ? { type: "video", id: m.id, video_url: url, mime_type: "video/mp4", thumbnail_url: thumb, title: m.title ?? "Video" } : null;
  }
  return thumb
    ? { type: "mpeg4_gif", id: m.id, mpeg4_url: url, thumbnail_url: thumb }
    : { type: "mpeg4_gif", id: m.id, mpeg4_url: url, thumbnail_url: url, thumbnail_mime_type: "video/mp4" };
}

/** Telegram input for a meme: its file_id, or the stored bytes for the first send. */
async function input(env: Env, m: Meme) {
  if (!isStored(m.file_unique_id)) return m.file_id;
  const media = await getMedia(env, "", m.file_unique_id, m.mime ?? "application/octet-stream");
  const ext = EXT[media.mime] ?? (m.kind === "photo" ? "jpg" : "mp4");
  return new InputFile(new Uint8Array(media.bytes), `${m.id}.${ext}`);
}

/** After the first send of an imported meme: keep Telegram's file ids and drop the R2 copy. */
async function adopt(env: Env, m: Meme, msg: Message) {
  const sent = isStored(m.file_unique_id) ? extractMedia(msg) : null;
  if (!sent) return;
  try {
    await env.DB.prepare("UPDATE memes SET file_id = ?, file_unique_id = ?, preview_file_id = ?, preview_unique_id = ? WHERE id = ?")
      .bind(sent.file_id, sent.file_unique_id, sent.preview_file_id, sent.preview_unique_id, m.id)
      .run();
  } catch (e) {
    return console.warn("keeping stored copy, file ids not saved", m.id, e); // e.g. the user already has this Telegram file
  }
  await env.MEDIA.delete([m.file_unique_id, m.preview_unique_id].filter(isStored).map((u) => storedKey(u!)));
}

/** Sends one meme to a chat, uploading imported bytes on first use. */
export async function sendMeme(env: Env, api: Api, chatId: number, m: Meme, other: object = {}) {
  const file = await input(env, m);
  const msg =
    m.kind === "photo"
      ? await api.sendPhoto(chatId, file, other)
      : m.kind === "video"
        ? await api.sendVideo(chatId, file, other)
        : await api.sendAnimation(chatId, file, other);
  await adopt(env, m, msg);
}

/** Sends search results as replies to the query: photo/video albums, then GIFs one by one. */
export async function sendResults(env: Env, api: Api, chatId: number, replyTo: number, memes: Meme[], lang: Lang) {
  const reply = { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };
  if (!memes.length) return api.sendMessage(chatId, t(lang, "nothing_found"), { ...reply, parse_mode: "HTML" });

  const album = memes.filter((m) => m.kind !== "animation");
  for (let i = 0; i < album.length; i += 10) {
    const chunk = album.slice(i, i + 10);
    if (chunk.length === 1) {
      await sendMeme(env, api, chatId, chunk[0], reply);
      continue;
    }
    const media = await Promise.all(chunk.map(async (m) => ({ type: m.kind === "photo" ? "photo" : "video", media: await input(env, m) }) as const));
    const sent = await api.sendMediaGroup(chatId, media, reply);
    await Promise.all(sent.map((msg, j) => adopt(env, chunk[j], msg)));
  }
  for (const m of memes.filter((m) => m.kind === "animation")) await sendMeme(env, api, chatId, m, reply);
}
