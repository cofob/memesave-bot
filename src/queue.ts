import { MAX_BUSY_ATTEMPTS, MAX_JOB_ATTEMPTS } from "./config";
import type { Env } from "./env";
import type { Lang } from "./i18n";
import { failImport, pollImports, submitImport } from "./batch";
import { describeStage, failIngest, finishStage } from "./ingest/describe";
import { embedStage, hashStage } from "./ingest/embed";
import { purgeStage } from "./purge";
import { rekeyStage } from "./rekey";
import { postJob } from "./channels";
import { linkJob } from "./ingest/link";
import { failSearch, searchJob } from "./search/chat";
import { thumbStage } from "./thumb";

export type SearchJob = { type: "search"; userId: number; messageId: number; placeholderId: number; query: string; lang: Lang };
export type Job =
  | { type: "embed" | "finish" | "hash" | "rekey" | "thumb"; memeId: string }
  | { type: "describe"; memeId: string; from?: number; single?: boolean } // from: index in describeModels (1 after a blocked batch request); single: not with its album
  | { type: "batch_submit"; importId: string }
  | { type: "batch_poll" }
  | { type: "post"; postId: string }
  | { type: "purge"; userId: number; before: number }
  | { type: "link"; userId: number; url: string } // API import (src/ingest/link.ts)
  | SearchJob;

async function run(env: Env, job: Job) {
  switch (job.type) {
    case "search":
      return searchJob(env, job);
    case "batch_submit":
      return submitImport(env, job.importId);
    case "batch_poll":
      return pollImports(env);
    case "post":
      return postJob(env, job.postId);
    case "embed":
      return embedStage(env, job.memeId);
    case "describe":
      return describeStage(env, job.memeId, job.from, job.single);
    case "finish":
      return finishStage(env, job.memeId);
    case "hash":
      return hashStage(env, job.memeId);
    case "rekey":
      return rekeyStage(env, job.memeId);
    case "purge":
      return purgeStage(env, job.userId, job.before);
    case "link":
      return linkJob(env, job.userId, job.url);
    case "thumb":
      return thumbStage(env, job.memeId);
  }
}

/** A rate limit or a busy database (Vectorize 429, D1 during an import): the job works later. */
export const isBusy = (e: unknown) => /too many requests|\b429\b|rate.?limit|long-running import|overloaded/i.test(String(e));

/** Seconds before the next attempt: 30 s steps; busy errors back off exponentially (1 min … 1 h) with jitter. */
export const retryDelay = (attempts: number, busy: boolean) =>
  busy ? Math.round(Math.min(60 * 2 ** (attempts - 1), 3600) * (0.75 + Math.random() / 2)) : 30 * attempts;

async function fail(env: Env, job: Job, error: unknown) {
  if (job.type === "search") return failSearch(env, job, error);
  if (job.type === "batch_submit") return failImport(env, job.importId, error);
  if (job.type === "batch_poll" || job.type === "hash" || job.type === "rekey") return; // cron runs them again
  if (job.type === "thumb") return env.JOBS.send({ type: "embed", memeId: job.memeId }); // goes on without a preview
  if (job.type === "purge" || job.type === "post" || job.type === "link") return; // idempotent: the dead letter queue keeps it for a manual re-run
  return failIngest(env, job.memeId, error);
}

export async function handleBatch(batch: MessageBatch<Job>, env: Env) {
  await Promise.all(
    batch.messages.map(async (msg) => {
      try {
        await run(env, msg.body);
        msg.ack();
      } catch (e) {
        console.error("job failed", msg.body, e);
        const busy = isBusy(e);
        // Search must not repeat: a partial answer may already be sent.
        if (msg.body.type === "search" || msg.attempts >= (busy ? MAX_BUSY_ATTEMPTS : MAX_JOB_ATTEMPTS)) {
          await fail(env, msg.body, e).catch(console.error);
          msg.ack();
        } else {
          msg.retry({ delaySeconds: retryDelay(msg.attempts, busy) });
        }
      }
    }),
  );
}
