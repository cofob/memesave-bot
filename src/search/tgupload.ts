import { Api, GrammyError } from "grammy";
import { lostChannel, storageChat } from "../channels";
import { UPLOAD_GAP_MS } from "../config";
import { getMeme, type Meme } from "../db";
import type { Env } from "../env";
import { isBusy } from "../queue";
import { sendMeme } from "./deliver";

// Inline results need Telegram file ids: memes only in R2 are uploaded silently to a storage chat in the background
// (all of them, by cron; the ones of an inline answer at once). One consumer (max_concurrency 1) and a gap between
// sends keep live traffic far from Telegram rate limits.

export type UploadJob = { userId: number; memeIds: string[] };
const MAX_UPLOAD = 50 * 2 ** 20; // Bot API upload limit
const MAX_PHOTO = 10 * 2 ** 20; // sendPhoto limit
const PER_CRON = Math.floor((15 * 60 * 1000) / UPLOAD_GAP_MS) - 40; // what the queue sends in 15 min, with a margin
const JOB = 25; // memes per job
const TRIES = 5; // a meme that fails this often is left to inline (it may be broken)

/** Ids of memes that are not in Telegram yet and can be uploaded. */
export const needUpload = (memes: Meme[]) =>
  memes.filter((m) => !m.file_id && m.r2_file && (m.file_size ?? 0) <= (m.kind === "photo" ? MAX_PHOTO : MAX_UPLOAD)).map((m) => m.id);

/** Cron: queues the newest memes that are not in Telegram yet, as many as the queue sends until the next run; a meme is queued again after 1 h at most TRIES times. */
export async function queueUploads(env: Env) {
  const { results } = await env.DB.prepare(
    `UPDATE memes SET upload_at = unixepoch(), upload_tries = upload_tries + 1 WHERE id IN (
       SELECT id FROM memes WHERE file_id = '' AND r2_file IS NOT NULL AND status != 'failed' AND upload_tries < ?1 AND (upload_at IS NULL OR upload_at < unixepoch() - 3600)
         AND COALESCE(file_size, 0) <= IIF(kind = 'photo', ?2, ?3) ORDER BY created_at DESC LIMIT ?4)
     RETURNING id, user_id`,
  )
    .bind(TRIES, MAX_PHOTO, MAX_UPLOAD, PER_CRON)
    .all<{ id: string; user_id: number }>();
  const byUser = new Map<number, string[]>();
  for (const r of results) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.id]);
  for (const [userId, ids] of byUser) for (let i = 0; i < ids.length; i += JOB) await env.UPLOADS.send({ userId, memeIds: ids.slice(i, i + JOB) });
}

/** Uploads the job's memes one by one; throws busy errors (the job retries later), stops when the chat is lost. */
export async function uploadJob(env: Env, api: Api, { userId, memeIds }: UploadJob, gap = UPLOAD_GAP_MS) {
  const chatId = await storageChat(env, userId);
  if (!chatId) return;
  let first = true;
  for (const id of memeIds) {
    const m = await getMeme(env.DB, id);
    if (!m || m.user_id !== userId || m.file_id) continue;
    if (!first) await scheduler.wait(gap);
    first = false;
    try {
      await sendMeme(env, api, chatId, m, { disable_notification: true });
    } catch (e) {
      if (isBusy(e)) throw e;
      if (lostChannel(e)) return console.warn("storage chat lost", chatId, e);
      console.warn("upload failed", id, e);
    }
  }
}

/** Consumer of the upload queue. No auto-retry on 429: the whole job waits for retry_after instead. */
export async function handleUploads(batch: MessageBatch<UploadJob>, env: Env) {
  const api = new Api(env.BOT_TOKEN);
  for (const msg of batch.messages) {
    try {
      await uploadJob(env, api, msg.body);
      msg.ack();
    } catch (e) {
      const wait = e instanceof GrammyError ? e.parameters.retry_after : undefined;
      console.warn("upload job delayed", e);
      msg.retry({ delaySeconds: (wait ?? 60) + 5 });
    }
  }
}
