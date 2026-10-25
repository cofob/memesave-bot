import { MAX_JOB_ATTEMPTS } from "./config";
import type { Env } from "./env";
import type { Lang } from "./i18n";
import { failImport, pollImports, submitImport } from "./batch";
import { describeStage, failIngest, finishStage } from "./ingest/describe";
import { embedStage, hashStage } from "./ingest/embed";
import { purgeStage } from "./purge";
import { rekeyStage } from "./rekey";
import { postJob } from "./channels";
import { failSearch, searchJob } from "./search/chat";

export type SearchJob = { type: "search"; userId: number; messageId: number; placeholderId: number; query: string; lang: Lang };
export type Job =
  | { type: "embed" | "finish" | "hash" | "rekey"; memeId: string }
  | { type: "describe"; memeId: string; from?: number } // from: index in describeModels (1 after a blocked batch request)
  | { type: "batch_submit"; importId: string }
  | { type: "batch_poll" }
  | { type: "post"; postId: string }
  | { type: "purge"; userId: number; before: number }
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
      return describeStage(env, job.memeId, job.from);
    case "finish":
      return finishStage(env, job.memeId);
    case "hash":
      return hashStage(env, job.memeId);
    case "rekey":
      return rekeyStage(env, job.memeId);
    case "purge":
      return purgeStage(env, job.userId, job.before);
  }
}

async function fail(env: Env, job: Job, error: unknown) {
  if (job.type === "search") return failSearch(env, job);
  if (job.type === "batch_submit") return failImport(env, job.importId, error);
  if (job.type === "batch_poll" || job.type === "hash" || job.type === "rekey") return; // cron runs them again
  if (job.type === "purge" || job.type === "post") return; // idempotent: the dead letter queue keeps it for a manual re-run
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
        // Search must not repeat: a partial answer may already be sent.
        if (msg.body.type === "search" || msg.attempts >= MAX_JOB_ATTEMPTS) {
          await fail(env, msg.body, e).catch(console.error);
          msg.ack();
        } else {
          msg.retry({ delaySeconds: 30 * msg.attempts });
        }
      }
    }),
  );
}
