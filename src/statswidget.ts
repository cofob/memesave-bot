// /stats as a widget: totals, saves per day and top tags, with a refresh button.
import type { Api } from "grammy";
import { tagStats } from "./analytics";
import type { User } from "./db";
import type { Env } from "./env";
import { fileSize, t, type Lang } from "./i18n";
import { userStats } from "./stats";
import { editWidget, sendWidget, type WidgetQuery } from "./widget";
import { statsPage } from "./widgetpages";

const DAYS = 30;

/** The widget state (under 1024 bytes: 30 numbers and 8 short tags) and the meme count for the caption. */
async function statsState(env: Env, user: User) {
  const db = env.DB;
  const [st, [days, tags]] = await Promise.all([
    userStats(env, user),
    db.batch<any>([
      // Days ago (UTC) of the memes saved in the last 30 days.
      db
        .prepare(
          `SELECT CAST((unixepoch('now', 'start of day') - unixepoch(created_at, 'unixepoch', 'start of day')) / 86400 AS INTEGER) AS ago, COUNT(*) AS n
           FROM memes WHERE user_id = ? AND created_at >= unixepoch('now', 'start of day', '-${DAYS - 1} days') GROUP BY ago`,
        )
        .bind(user.id),
      db.prepare("SELECT tags, '' AS month FROM memes WHERE user_id = ? AND tags IS NOT NULL").bind(user.id),
    ]),
  ]);
  const d = Array<number>(DAYS).fill(0);
  for (const r of days.results) d[DAYS - 1 - r.ago] = r.n;
  const g = tagStats(tags.results)
    .top.slice(0, 8)
    .map((x) => [x.tag.slice(0, 20), x.count]);
  return { total: st.total, data: JSON.stringify({ m: st.total, z: fileSize(st.bytes), c: `$${st.spend30.toFixed(2)}`, d, g }) };
}

/** Sends the stats widget; false when Telegram refuses it (the caller sends the text). */
export async function sendStatsWidget(env: Env, api: Api, user: User, lang: Lang, reply_markup: unknown) {
  const { total, data } = await statsState(env, user);
  const caption = t(lang, "w_stats_caption", { total });
  return !!(await sendWidget(api, { chat_id: user.id, html: statsPage(lang), caption, parse_mode: "HTML", chat_data: data, allow_queries: true, reply_markup }));
}

/** The refresh button: new state for the widget in the user's own chat. */
export async function statsQuery(env: Env, api: Api, q: WidgetQuery, user: User) {
  if (q.chat?.id !== user.id || !q.message_id) return;
  await editWidget(api, user.id, q.message_id, (await statsState(env, user)).data);
}
