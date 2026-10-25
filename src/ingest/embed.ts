import { deleteMeme, getMeme, setStatus, userLang, type Meme } from "../db";
import type { Env } from "../env";
import { t } from "../i18n";
import { getMedia, toDataUrl } from "../media";
import { embed } from "../openrouter";
import { editStatus } from "./describe";

const DOWNLOAD_MAX = 20 * 1024 * 1024; // Bot API getFile limit

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * sha256 of the meme file for dedupe. "" when the file cannot be downloaded (videos over 20 MB).
 * Downloads are cached in R2, so stage 2 reuses them.
 */
async function fileHash(env: Env, m: Meme): Promise<string> {
  if (m.kind !== "photo" && (m.file_size ?? 0) > DOWNLOAD_MAX) return "";
  try {
    const media = await getMedia(env, m.file_id, m.file_unique_id, m.mime ?? "application/octet-stream");
    return hex(await crypto.subtle.digest("SHA-256", media.bytes));
  } catch (e) {
    console.warn("hash failed", m.id, e);
    return "";
  }
}

/** Saves the hash; true when the user already has a meme with the same bytes (then this one is removed). */
async function dedupe(env: Env, m: Meme): Promise<boolean> {
  const sha256 = await fileHash(env, m);
  const other = sha256
    ? await env.DB.prepare("SELECT id FROM memes WHERE user_id = ? AND sha256 = ? AND id != ?").bind(m.user_id, sha256, m.id).first<string>("id")
    : null;
  if (!other) {
    await env.DB.prepare("UPDATE memes SET sha256 = ? WHERE id = ?").bind(sha256, m.id).run();
    return false;
  }
  await deleteMeme(env, m.id);
  await editStatus(env, m, t(await userLang(env.DB, m.user_id), "already_saved"));
  return true;
}

/** Backfill job: hash an existing meme without dedupe. */
export async function hashStage(env: Env, memeId: string) {
  const m = await getMeme(env.DB, memeId);
  if (m && m.sha256 === null) await env.DB.prepare("UPDATE memes SET sha256 = ? WHERE id = ?").bind(await fileHash(env, m), m.id).run();
}

/** Cron: queue hash jobs for memes saved before hashing existed. */
export async function queueHashBackfill(env: Env) {
  const { results } = await env.DB.prepare("SELECT id FROM memes WHERE sha256 IS NULL AND status IN ('ready', 'failed') LIMIT 100").all<{ id: string }>();
  if (results.length) await env.JOBS.sendBatch(results.map((r) => ({ body: { type: "hash" as const, memeId: r.id } })));
}

export const namespace = (userId: number) => `u${userId}`;

/**
 * Vectorize rate-limits bursts of upserts ("Too Many Requests"). Retry here with backoff instead of failing
 * the job: a queue retry would pay for the embedding again.
 */
export async function upsertVectors(env: Env, vectors: VectorizeVector[], wait = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await env.VECTORS.upsert(vectors);
    } catch (e) {
      if (attempt >= 5 || !/Too Many Requests|40041/.test(String(e))) throw e;
      await wait(500 * 2 ** attempt + Math.random() * 500);
    }
  }
}

/** Stage 1: embeds the image (or the video thumbnail) into Vectorize. */
export async function embedStage(env: Env, memeId: string) {
  const m = await getMeme(env.DB, memeId);
  if (!m || m.status === "ready" || m.status === "failed") return;
  if (m.status === "embedding") {
    if (m.sha256 === null && (await dedupe(env, m))) return;
    const [fileId, uniqueId] = m.kind === "photo" ? [m.file_id, m.file_unique_id] : [m.preview_file_id ?? "", m.preview_unique_id];
    if (uniqueId) {
      const media = await getMedia(env, fileId, uniqueId, "image/jpeg");
      const [values] = await embed(
        env,
        [{ content: [{ type: "image_url", image_url: { url: toDataUrl(media) } }] }],
        "search_document",
        { userId: m.user_id, kind: "embed_image", memeId },
      );
      await upsertVectors(env, [{ id: `${memeId}:i`, values, namespace: namespace(m.user_id), metadata: { kind: m.kind } }]);
    }
    await setStatus(env.DB, memeId, "describing");
  }
  // Batch import memes wait for /batch_finish instead.
  if (!m.import_id) await env.JOBS.send({ type: "describe", memeId });
}
