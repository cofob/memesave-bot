import { botApi } from "./botapi";
import { MODELS } from "./config";
import { userLang, type Meme } from "./db";
import type { Env } from "./env";
import { esc, t, usd, type Key } from "./i18n";
import { describeRequest, parseJson, saveDescription, toDescription, topTags } from "./ingest/describe";
import { signedMediaUrl } from "./media";
import { createBatch, getBatch, type Batch, type KeySource } from "./openrouter";
import type { Job } from "./queue";
import { recordSpend } from "./spend";

const BATCH_MAX = 5000; // OpenRouter limit per batch
const MEDIA_TTL = 5 * 86400; // longer than the 96 h Vertex window, shorter than the 7-day R2 lifecycle
const RUNNING = ["validating", "in_progress", "finalizing"];
const MAX_ATTEMPTS = 3; // batch submits per import before giving up on failed photos
// After the last attempt only a few stragglers go to the full-price pipeline; a batch that mostly failed
// (e.g. the provider rejected it) is stopped instead of being re-run at twice the cost.
const fallbackLimit = (photos: number) => Math.max(5, Math.ceil(photos * 0.1));

interface Import {
  id: string;
  user_id: number;
  status: string;
  batch_id: string | null;
  key_source: KeySource | null;
  status_msg_id: number | null;
  attempts: number;
  described: number;
  cost: number;
}

type Status = Pick<Import, "user_id" | "status_msg_id">;

/** Progress: edits the import's status message from /batch_finish. */
async function progress(env: Env, imp: Status, key: Key, params: Record<string, string | number> = {}) {
  const text = t(await userLang(env.DB, imp.user_id), key, params);
  const api = botApi(env.BOT_TOKEN);
  const html = { parse_mode: "HTML" } as const;
  const sent = imp.status_msg_id ? api.editMessageText(imp.user_id, imp.status_msg_id, text, html) : api.sendMessage(imp.user_id, text, html);
  await sent.catch(console.error);
}

/** Completion: a new message (so the user gets a notification), as a reply to the status message. */
async function notify(env: Env, imp: Status, key: Key, params: Record<string, string | number> = {}) {
  const text = t(await userLang(env.DB, imp.user_id), key, params);
  const reply = imp.status_msg_id ? { reply_parameters: { message_id: imp.status_msg_id, allow_sending_without_reply: true } } : {};
  await botApi(env.BOT_TOKEN).sendMessage(imp.user_id, text, { parse_mode: "HTML", ...reply }).catch(console.error);
}

async function sendJobs(env: Env, jobs: Job[]) {
  for (let i = 0; i < jobs.length; i += 100) await env.JOBS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
}

const describeJobs = (memes: Meme[]): Job[] => memes.map((m) => ({ type: "describe", memeId: m.id }));

/** Memes of an import that still wait for a description. */
const pending = async (db: D1Database, importId: string) =>
  (
    await db
      .prepare("SELECT * FROM memes WHERE import_id = ? AND status IN ('embedding', 'describing') AND title IS NULL")
      .bind(importId)
      .all<Meme>()
  ).results;

export const collectingImport = (db: D1Database, userId: number) =>
  db.prepare("SELECT id FROM imports WHERE user_id = ? AND status = 'collecting'").bind(userId).first<string>("id");

export const countMemes = async (db: D1Database, importId: string) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM memes WHERE import_id = ?").bind(importId).first<number>("n")) ?? 0;

/** Opens batch mode. Returns the photo count when it was already open. */
export async function startImport(db: D1Database, userId: number): Promise<{ created: boolean; count: number }> {
  const id = await db
    .prepare("INSERT INTO imports (id, user_id, status) VALUES (?, ?, 'collecting') ON CONFLICT DO NOTHING RETURNING id")
    .bind(crypto.randomUUID().replaceAll("-", ""), userId)
    .first<string>("id");
  if (id) return { created: true, count: 0 };
  return { created: false, count: await countMemes(db, (await collectingImport(db, userId))!) };
}

/** The batch-level error, or the first per-request error. */
export function batchError(batch: Batch): string {
  const first = (batch.results ?? []).map((r) => (r.error as { message?: string } | undefined)?.message).find(Boolean);
  return batch.error?.message ?? first ?? `batch ${batch.status}`;
}

export interface ImportProgress {
  id: string;
  status: string;
  attempts: number;
  described: number;
  cost: number;
  created_at: number;
  photos: number;
  pending: number;
  failed: number;
  ready: number;
  live: { status: string; total: number; completed: number; failed: number } | null; // OpenRouter batch while it runs
}

/** Recent imports with per-photo progress and the live OpenRouter batch status (/batch_status and the app). */
export async function batchProgress(env: Env, userId: number): Promise<{ collecting: ImportProgress | null; recent: ImportProgress[]; failed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.status, i.attempts, i.described, i.cost, i.created_at, i.batch_id, i.key_source,
       COUNT(m.id) AS photos,
       SUM(m.status IN ('embedding', 'describing')) AS pending,
       SUM(m.status = 'failed') AS failed,
       SUM(m.status = 'ready') AS ready
     FROM imports i LEFT JOIN memes m ON m.import_id = i.id
     WHERE i.user_id = ? GROUP BY i.id ORDER BY i.created_at DESC LIMIT 6`,
  )
    .bind(userId)
    .all<ImportProgress & { batch_id: string | null; key_source: KeySource | null }>();
  const rows = await Promise.all(
    results.map(async ({ batch_id, key_source, ...r }) => {
      let live: ImportProgress["live"] = null;
      if (r.status === "submitted" && batch_id) {
        const b = await getBatch(env, userId, key_source ?? "global", batch_id).catch(() => null);
        if (b) live = { status: b.status, total: b.request_counts?.total ?? 0, completed: b.request_counts?.completed ?? 0, failed: b.request_counts?.failed ?? 0 };
      }
      return { ...r, pending: r.pending ?? 0, failed: r.failed ?? 0, ready: r.ready ?? 0, live };
    }),
  );
  const failed =
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM memes WHERE user_id = ? AND status = 'failed'").bind(userId).first<number>("n")) ?? 0;
  return { collecting: rows.find((r) => r.status === "collecting") ?? null, recent: rows.filter((r) => r.status !== "collecting"), failed };
}

/**
 * /batch_retry: failed photos go into a new half-price batch (stage 1 runs again first);
 * failed videos and GIFs go through the normal pipeline. Returns how many memes were retried.
 */
export async function retryFailed(env: Env, userId: number, statusMsgId: number | null) {
  const db = env.DB;
  const importId = crypto.randomUUID().replaceAll("-", "");
  // Photos that already have a description skip the batch: describeStage reuses it and only finishes them.
  const [photos, others] = await db.batch<{ id: string }>([
    db.prepare(
      "UPDATE memes SET status = 'embedding', error = NULL, import_id = ?, updated_at = unixepoch() WHERE user_id = ? AND status = 'failed' AND kind = 'photo' AND title IS NULL RETURNING id",
    ).bind(importId, userId),
    db.prepare(
      "UPDATE memes SET status = 'embedding', error = NULL, import_id = NULL, updated_at = unixepoch() WHERE user_id = ? AND status = 'failed' RETURNING id",
    ).bind(userId),
  ]);
  if (photos.results.length) {
    await db.prepare("INSERT INTO imports (id, user_id, status, status_msg_id) VALUES (?, ?, 'submitting', ?)").bind(importId, userId, statusMsgId).run();
  }
  const embed = [...photos.results, ...others.results].map((r): Job => ({ type: "embed", memeId: r.id }));
  await sendJobs(env, photos.results.length ? [...embed, { type: "batch_submit", importId }] : embed);
  return { photos: photos.results.length, others: others.results.length };
}

/** /batch_finish from the app: the bot posts the status message in the chat, as for the command. */
export async function finishImportFromApp(env: Env, userId: number): Promise<boolean> {
  const id = await collectingImport(env.DB, userId);
  if (!id) return false;
  const text = t(await userLang(env.DB, userId), "batch_finishing", { n: await countMemes(env.DB, id) });
  const msg = await botApi(env.BOT_TOKEN).sendMessage(userId, text, { parse_mode: "HTML" });
  return finishImport(env, userId, msg.message_id);
}

/** Closes batch mode and queues the submit; later updates edit `statusMsgId`. Returns false when batch mode is off. */
export async function finishImport(env: Env, userId: number, statusMsgId: number): Promise<boolean> {
  const id = await env.DB.prepare(
    "UPDATE imports SET status = 'submitting', status_msg_id = ?, updated_at = unixepoch() WHERE user_id = ? AND status = 'collecting' RETURNING id",
  )
    .bind(statusMsgId, userId)
    .first<string>("id");
  if (!id) return false;
  await env.JOBS.send({ type: "batch_submit", importId: id });
  return true;
}

/** Closes batch mode; collected photos continue in the normal pipeline. Returns the photo count, or null. */
export async function cancelImport(env: Env, userId: number): Promise<number | null> {
  const id = await env.DB.prepare(
    "UPDATE imports SET status = 'cancelled', updated_at = unixepoch() WHERE user_id = ? AND status = 'collecting' RETURNING id",
  )
    .bind(userId)
    .first<string>("id");
  if (!id) return null;
  const memes = await pending(env.DB, id);
  await env.DB.prepare("UPDATE memes SET import_id = NULL WHERE import_id = ?").bind(id).run();
  await sendJobs(env, describeJobs(memes.filter((m) => m.status === "describing")));
  return memes.length;
}

/** Submits one describe batch for the import's photos (no server tools; images as signed URLs). */
export async function submitImport(env: Env, importId: string) {
  const imp = await env.DB.prepare("SELECT * FROM imports WHERE id = ?").bind(importId).first<Import>();
  if (imp?.status !== "submitting") return;
  await finishDescribed(env, importId);
  const memes = await pending(env.DB, importId);
  if (memes.some((m) => m.status === "embedding")) {
    // Photos are cached in R2 by stage 1; wait until it finishes.
    await env.JOBS.send({ type: "batch_submit", importId }, { delaySeconds: 30 });
    return;
  }
  if (!memes.length) {
    await env.DB.prepare("UPDATE imports SET status = 'done', updated_at = unixepoch() WHERE id = ?").bind(importId).run();
    return progress(env, imp, "batch_empty");
  }

  const [inBatch, rest] = [memes.slice(0, BATCH_MAX), memes.slice(BATCH_MAX)];
  await sendJobs(env, describeJobs(rest));
  const tags = await topTags(env.DB, imp.user_id);
  const requests = await Promise.all(
    inBatch.map(async (m) => ({
      custom_id: m.id,
      body: describeRequest(m, tags, [{ type: "image_url", image_url: { url: await signedMediaUrl(env, m, "file", MEDIA_TTL, env.MEDIA_URL ?? env.PUBLIC_URL) } }]),
    })),
  );
  const { batch, source } = await createBatch(
    env,
    imp.user_id,
    {
      endpoint: "/v1/chat/completions",
      model: MODELS.describeImage,
      completion_window: "24h",
      callback_url: `${env.PUBLIC_URL.replace(/\/$/, "")}/batch/webhook`,
    },
    requests,
  );
  const attempt = imp.attempts + 1;
  await env.DB.prepare(
    "UPDATE imports SET status = 'submitted', batch_id = ?, key_source = ?, attempts = ?, updated_at = unixepoch() WHERE id = ?",
  )
    .bind(batch.id, source, attempt, importId)
    .run();
  const retrying = attempt > 1;
  await progress(env, imp, retrying ? "batch_resubmitted" : "batch_submitted", { n: inBatch.length, attempt, max: MAX_ATTEMPTS });
}

/** Last-retry failure of a submit: the photos go to the normal pipeline. */
export async function failImport(env: Env, importId: string, error: unknown) {
  const imp = await env.DB.prepare(
    "UPDATE imports SET status = 'failed', error = ?, updated_at = unixepoch() WHERE id = ? RETURNING user_id, status_msg_id",
  )
    .bind(String(error).slice(0, 1000), importId)
    .first<Status>();
  if (!imp) return;
  const memes = await pending(env.DB, importId);
  await sendJobs(env, describeJobs(memes));
  await notify(env, imp, "batch_failed", { n: memes.length });
}

/** Checks all submitted imports; called by the OpenRouter webhook and by cron. */
export async function pollImports(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM imports WHERE status = 'submitted'").all<Import>();
  for (const imp of results) {
    await finishDescribed(env, imp.id);
    await pollImport(env, imp).catch((e) => console.error("batch poll failed", imp.id, e));
  }
}

/**
 * Memes of an import that already have a description (e.g. a retry after a later step failed) do not need
 * the batch: detach them and run only the last step (text embedding, ready).
 */
async function finishDescribed(env: Env, importId: string) {
  const { results } = await env.DB.prepare(
    "UPDATE memes SET import_id = NULL WHERE import_id = ? AND status = 'describing' AND title IS NOT NULL RETURNING id",
  )
    .bind(importId)
    .all<{ id: string }>();
  await sendJobs(env, results.map((r): Job => ({ type: "finish", memeId: r.id })));
}

async function pollImport(env: Env, imp: Import) {
  const db = env.DB;
  const batch = await getBatch(env, imp.user_id, imp.key_source!, imp.batch_id!);
  if (RUNNING.includes(batch.status)) return;
  const claimed = await db
    .prepare("UPDATE imports SET status = 'processing', updated_at = unixepoch() WHERE id = ? AND status = 'submitted' RETURNING id")
    .bind(imp.id)
    .first();
  if (!claimed) return; // another poll took it

  try {
    const byId = new Map((batch.results ?? []).map((r) => [r.custom_id, r]));
    const saved: string[] = [];
    const retry: Meme[] = [];
    const updates: D1PreparedStatement[] = [];
    for (const m of await pending(db, imp.id)) {
      const content: string = byId.get(m.id)?.response?.choices?.[0]?.message?.content ?? "";
      try {
        updates.push(saveDescription(db, m.id, toDescription(parseJson(content), content)));
        saved.push(m.id);
      } catch {
        retry.push(m);
      }
    }
    for (let i = 0; i < updates.length; i += 100) await db.batch(updates.slice(i, i + 100));
    if (batch.usage) await recordSpend(db, { userId: imp.user_id, kind: "describe_batch" }, MODELS.describeImage, imp.key_source!, batch.usage);
    await sendJobs(env, saved.map((memeId): Job => ({ type: "finish", memeId })));
    const described = imp.described + saved.length;
    const cost = imp.cost + (batch.usage?.cost ?? 0);
    // Keep the batch status and the first errors to debug failures.
    const errors = (batch.results ?? []).filter((r) => r.error).slice(0, 3);
    const error = batch.status === "completed" && !errors.length ? null : JSON.stringify({ ...batch, results: errors }).slice(0, 2000);

    if (retry.length && imp.attempts < MAX_ATTEMPTS) {
      // Resubmit only the failed photos (they are still pending) in a new batch.
      await db.prepare("UPDATE imports SET status = 'submitting', described = ?, cost = ?, error = ?, updated_at = unixepoch() WHERE id = ?")
        .bind(described, cost, error, imp.id)
        .run();
      await env.JOBS.send({ type: "batch_submit", importId: imp.id }, { delaySeconds: 60 });
      return;
    }

    const fallback = retry.length <= fallbackLimit(saved.length + retry.length);
    const reason = batchError(batch);
    if (fallback) {
      await sendJobs(env, describeJobs(retry));
    } else {
      for (let i = 0; i < retry.length; i += 50) {
        const ids = retry.slice(i, i + 50).map((m) => m.id);
        await db.prepare(`UPDATE memes SET status = 'failed', error = ?, updated_at = unixepoch() WHERE id IN (${ids.map(() => "?").join(",")})`)
          .bind(`batch: ${reason}`.slice(0, 1000), ...ids)
          .run();
      }
    }
    const status = described && fallback ? "done" : "failed";
    await db.prepare("UPDATE imports SET status = ?, described = ?, cost = ?, error = ?, updated_at = unixepoch() WHERE id = ?")
      .bind(status, described, cost, error, imp.id)
      .run();
    const key = !fallback ? "batch_stopped" : described ? "batch_done" : "batch_failed";
    await notify(env, imp, key, { ok: described, n: retry.length, cost: usd(cost), reason: esc(reason.slice(0, 300)) });
  } catch (e) {
    await db.prepare("UPDATE imports SET status = 'submitted' WHERE id = ?").bind(imp.id).run();
    throw e;
  }
}
