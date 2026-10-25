import { botApi } from "../botapi";
import { CHAT_LIMIT } from "../config";
import { getUser } from "../db";
import type { Env } from "../env";
import { t } from "../i18n";
import type { SearchJob } from "../queue";
import { agentSearch } from "./agent";
import { sendResults } from "./deliver";
import { fastSearch } from "./fast";

/** Chat search job: runs the user's search mode and replaces the placeholder with results. */
export async function searchJob(env: Env, job: SearchJob) {
  const user = await getUser(env.DB, job.userId);
  if (!user) return;
  const api = botApi(env.BOT_TOKEN);
  await api.sendChatAction(job.userId, "typing").catch(() => {});
  const memes =
    user.search_mode === "fast" ? await fastSearch(env, user.id, job.query, CHAT_LIMIT) : await agentSearch(env, user.id, job.query);
  await api.deleteMessage(job.userId, job.placeholderId).catch(() => {});
  await sendResults(env, api, job.userId, job.messageId, memes, job.lang);
}

export async function failSearch(env: Env, job: SearchJob) {
  await botApi(env.BOT_TOKEN).editMessageText(job.userId, job.placeholderId, t(job.lang, "search_failed"), { parse_mode: "HTML" });
}
