import { MAX_JOB_ATTEMPTS } from "./config";
import type { Env } from "./env";
import type { Lang } from "./i18n";
import { failImport, pollImports, submitImport } from "./batch";
import { describeStage, failIngest, finishStage } from "./ingest/describe";
import { embedStage, hashStage } from "./ingest/embed";
import { failSearch, searchJob } from "./search/chat";

export type SearchJob = { type: "search"; userId: number; messageId: number; placeholderId: number; query: string; lang: Lang };
export type Job =
  | { type: "embed" | "describe" | "finish" | "hash"; memeId: string }
  | { type: "batch_submit"; importId: string }
  | { type: "batch_poll" }
  | SearchJob;

async function run(env: Env, job: Job) {
  switch (job.type) {
    case "search":
      return searchJob(env, job);
    case "batch_submit":
      return submitImport(env, job.importId);
    case "batch_poll":
      return pollImports(env);
    case "embed":
      return embedStage(env, job.memeId);
    case "describe":
      return describeStage(env, job.memeId);
    case "finish":
      return finishStage(env, job.memeId);
    case "hash":
      return hashStage(env, job.memeId);
  }
}

async function fail(env: Env, job: Job, error: unknown) {
  if (job.type === "search") return failSearch(env, job);
  if (job.type === "batch_submit") return failImport(env, job.importId, error);
  if (job.type === "batch_poll" || job.type === "hash") return; // cron runs them again
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
