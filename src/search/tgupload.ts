import { Api, GrammyError } from "grammy";
import { lostChannel, storageChat } from "../channels";
import { UPLOAD_GAP_MS } from "../config";
import { getMeme, type Meme } from "../db";
import type { Env } from "../env";
import { isBusy } from "../queue";
import { sendMeme } from "./deliver";

// Inline results need Telegram file ids: memes only in R2 are uploaded silently to a storage chat in the background.
// One consumer (max_concurrency 1) and a gap between sends keep live traffic far from Telegram rate limits.

export type UploadJob = { userId: number; memeIds: string[] };
const MAX_UPLOAD = 50 * 2 ** 20; // Bot API upload limit

/** Ids of memes that are not in Telegram yet and can be uploaded. */
export const needUpload = (memes: Meme[]) =>
  memes.filter((m) => !m.file_id && m.r2_file && (m.file_size ?? 0) <= MAX_UPLOAD).map((m) => m.id);

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
