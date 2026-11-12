import { InputFile, type Api } from "grammy";
import type { Message } from "grammy/types";
import { addToPost, albumMemes } from "./channels";
import { blursPorn, getMeme, type Meme } from "./db";
import type { Env } from "./env";
import { extOf, memeMedia } from "./media";

// Sound of photos: one audio track per post (a single photo or an album), shared by all its memes.
// The bot sends it as an audio message after the photos, or with them as one video (clip, made by thumb/clip.go).

export const AUDIO_MAX = 20 << 20;
export const isAudio = (mime: string) => mime.startsWith("audio/");

export interface AudioPost {
  id: string;
  user_id: number;
  audio_r2: string | null;
  audio_mime: string | null;
  audio_file_id: string | null;
  clip_r2: string | null;
  clip_file_id: string | null;
}

/** The post of a meme: its newest album (as albumMemes), else its newest single post. */
const ORDER = "ORDER BY p.media_group_id IS NULL, p.created_at DESC, p.rowid DESC";

export const postOf = (db: D1Database, memeId: string) =>
  db.prepare(`SELECT p.* FROM post_items i JOIN posts p ON p.id = i.post_id WHERE i.meme_id = ? ${ORDER} LIMIT 1`).bind(memeId).first<AudioPost>();

/** The post of a meme; an old meme without one gets a single post. */
export const memePost = async (db: D1Database, userId: number, memeId: string) =>
  (await postOf(db, memeId))?.id ?? (await addToPost(db, userId, { memeId }));

/** Meme id → its post, for the memes whose post has audio. */
export async function audioPosts(db: D1Database, ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; audio_r2: string }>();
  const { results } = await db
    .prepare(
      `SELECT meme_id, id, audio_r2 FROM (SELECT i.meme_id, p.id, p.audio_r2, ROW_NUMBER() OVER (PARTITION BY i.meme_id ${ORDER}) AS r
       FROM post_items i JOIN posts p ON p.id = i.post_id WHERE i.meme_id IN (${ids.map(() => "?").join(",")})) WHERE r = 1 AND audio_r2 IS NOT NULL`,
    )
    .bind(...ids)
    .all<{ meme_id: string; id: string; audio_r2: string }>();
  return new Map(results.map(({ meme_id, ...p }) => [meme_id, p]));
}

/** Why an uploaded audio file is not accepted, or null. */
export const audioError = (f: File) => (!isAudio(f.type) || f.size > AUDIO_MAX ? "audio must be an audio file up to 20 MB" : null);

/** Sets (or with null removes) the audio of a saved photo: on its album, shared by all its photos. Returns an error or null. */
export async function attachAudio(env: Env, meme: Meme, file: File | null) {
  if (meme.kind !== "photo") return "audio is only for photos";
  if (file && audioError(file)) return audioError(file);
  const postId = file ? await memePost(env.DB, meme.user_id, meme.id) : (await postOf(env.DB, meme.id))?.id;
  if (postId) await setAudio(env, postId, file && { bytes: await file.arrayBuffer(), mime: file.type });
  return null;
}

/** Sets (or with null removes) the audio of a post; the old audio and clip are deleted. */
export async function setAudio(env: Env, postId: string, audio: { bytes: ArrayBuffer | Uint8Array; mime: string } | null) {
  const p = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).first<AudioPost>();
  if (!p) return;
  // A new key for each upload: signed audio URLs are cached by URL.
  const key = audio && `u/${p.user_id}/audio/${postId}.${crypto.randomUUID().slice(0, 8)}.${extOf(audio.mime)}`;
  if (audio) await env.MEDIA.put(key!, audio.bytes, { httpMetadata: { contentType: audio.mime } });
  await env.DB.prepare("UPDATE posts SET audio_r2 = ?, audio_mime = ?, audio_file_id = NULL, clip_r2 = NULL, clip_file_id = NULL WHERE id = ?")
    .bind(key, audio?.mime ?? null, postId)
    .run();
  const old = [p.audio_r2, p.clip_r2].filter((k): k is string => !!k);
  if (old.length) await env.MEDIA.delete(old);
}

/** Sends by the saved Telegram file id; without one (or when Telegram rejects it) uploads the R2 copy and saves the new id. */
async function sendCached(env: Env, p: AudioPost, col: "audio" | "clip", send: (file: string | InputFile) => Promise<Message>) {
  const fileId = p[`${col}_file_id`];
  if (fileId) {
    try {
      return await send(fileId);
    } catch (e) {
      console.warn(`${col} file_id send failed, uploading from R2`, e);
    }
  }
  const obj = await env.MEDIA.get(p[`${col}_r2`]!);
  if (!obj) throw new Error(`no ${col} for post ${p.id}`);
  const msg = await send(new InputFile(new Uint8Array(await obj.arrayBuffer()), `${col}.${extOf(obj.httpMetadata?.contentType ?? "")}`));
  const id = msg.audio?.file_id ?? msg.video?.file_id;
  if (id) await env.DB.prepare(`UPDATE posts SET ${col}_file_id = ? WHERE id = ?`).bind(id, p.id).run();
  return msg;
}

/** Sends the audio of the meme's post (if it has one) after its photos. */
export async function sendPostAudio(env: Env, api: Api, chatId: number, memeId: string, other: object = {}) {
  const p = await postOf(env.DB, memeId);
  if (p?.audio_r2) await sendCached(env, p, "audio", (f) => api.sendAudio(chatId, f, other));
}

/** Makes the clip of a post: its photos in album order with the audio (ffmpeg in the user's thumb container). */
async function renderClip(env: Env, p: AudioPost, memeId: string) {
  const album = await albumMemes(env.DB, memeId);
  const photos = (album.length ? album : [await getMeme(env.DB, memeId)]).filter((m): m is Meme => m?.kind === "photo");
  const audio = await env.MEDIA.get(p.audio_r2!);
  if (!photos.length || !audio) throw new Error(`no photos or audio for post ${p.id}`);
  const form = new FormData();
  for (const [i, m] of photos.entries()) {
    const { bytes, mime } = await memeMedia(env, m, "file");
    form.append("image", new File([bytes], `${i}.${extOf(mime)}`, { type: mime }));
  }
  form.append("audio", new File([await audio.arrayBuffer()], `audio.${extOf(p.audio_mime ?? "")}`, { type: p.audio_mime ?? "" }));
  const res = await env.THUMB.get(env.THUMB.idFromName(`u${p.user_id}`)).fetch("http://thumb/clip", { method: "POST", body: form });
  if (!res.ok) throw new Error(`clip ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const key = p.audio_r2!.replace(/\.[^.]+$/, `.${crypto.randomUUID().slice(0, 8)}.clip.mp4`); // new key: signed URLs are cached by URL
  await env.MEDIA.put(key, await res.arrayBuffer(), { httpMetadata: { contentType: "video/mp4" } });
  await env.DB.prepare("UPDATE posts SET clip_r2 = ?, clip_file_id = NULL WHERE id = ?").bind(key, p.id).run();
  const num = (h: string) => Math.round(Number(res.headers.get(h))) || undefined;
  return { key, meta: { width: num("X-Width"), height: num("X-Height"), duration: num("X-Duration") } };
}

/** Sends the photos of the meme's post with its audio as one video, made once and then kept in R2 and Telegram. */
export async function sendClip(env: Env, api: Api, chatId: number, memeId: string) {
  const clip = await ensureClip(env, memeId);
  if (!clip) return false;
  const album = await albumMemes(env.DB, memeId);
  const spoiler = await blursPorn(env.DB, chatId, album.length ? album : [(await getMeme(env.DB, memeId)) ?? { porn: 0 }]);
  await sendCached(env, clip.post, "clip", (f) => api.sendVideo(chatId, f, { ...clip.meta, supports_streaming: true, ...(spoiler && { has_spoiler: true }) }));
  return true;
}

/** The post of the meme with its clip made (meta: size of a new clip); null without audio. */
export async function ensureClip(env: Env, memeId: string) {
  const post = await postOf(env.DB, memeId);
  if (!post?.audio_r2) return null;
  let meta = {};
  if (!post.clip_r2) ({ key: post.clip_r2, meta } = await renderClip(env, post, memeId));
  return { post, meta };
}
