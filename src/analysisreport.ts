// Bot report of an embedding analysis: one rich message (Bot API sendRichMessage) with tables and the chart PNGs
// that the analyze/ container rendered.
import { InputFile } from "grammy";
import type { InputRichMessageMedia } from "grammy/types";
import type { Analysis, Cluster } from "./analysis";
import { imageKey, resultKey } from "./analysis";
import type { userAnalytics } from "./analytics";
import { botApi } from "./botapi";
import { getUser, userLang } from "./db";
import type { Env } from "./env";
import { fileSize, t, usd, type Key, type Lang } from "./i18n";
import type { userStats } from "./stats";

type Snapshot = Awaited<ReturnType<typeof userAnalytics>> & { stats: Awaited<ReturnType<typeof userStats>> };

interface Result {
  analytics: Snapshot; // the SQL stats at the time of the analysis
  count: number;
  clusters: Cluster[];
  trends?: { rising: number[]; fading: number[] };
  moods?: { emoji: string[]; names: Record<string, string[]>; keys: string[]; top: number[] };
  duplicates: [string, string, number][];
  outliers: string[];
  alignment?: { worst: [string, number][] };
  titles?: Record<string, string>; // titles of the memes listed in the report (added by sendReport)
  images?: string[]; // rendered PNG names
}

/** Text for a Markdown table cell or a paragraph: Markdown syntax characters are escaped. */
export const md = (s: string) => s.replace(/[\\`*_~|[\]()#<>=!$]/g, "\\$&").replace(/\n/g, " ");

export const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map((_, i) => (i ? "---:" : ":---")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/** Builds the report Markdown in the order of the web page; `image(name, caption)` returns the media block of a
 * rendered chart or "". */
export function reportMarkdown(lang: Lang, r: Result, image: (name: string, caption: Key) => string) {
  const a = r.analytics;
  const st = a.stats;
  const tr = (k: Key, p: Record<string, string | number> = {}) => t(lang, k, p);
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const title = (id: string) => md(r.titles?.[id] || "—");
  const section = (name: Key, intro: Key | string) => [`## ${tr(name)}`, intro.startsWith("rep_") ? tr(intro as Key) : intro];
  const parts: (string | false)[] = [`# ${tr("rep_title")}`, tr("rep_intro", { n: r.count })];

  parts.push(
    ...section("rep_collection", "rep_intro_overview"),
    table(
      [tr("rep_metric"), tr("rep_value")],
      [
        [tr("rep_memes"), `${st.total} (${st.photo} / ${st.video} / ${st.animation})`],
        [tr("rep_storage"), fileSize(st.bytes)],
        [tr("rep_spend"), usd(st.spend)],
        [tr("rep_spend30"), usd(st.spend30)],
        [tr("rep_avg"), usd(st.avg)],
      ],
    ),
    image("per_day", "rep_per_day"),
    image("total", "rep_total"),
    image("heatmap", "rep_heatmap"),
    image("saved", "rep_saved_at"),
    image("kinds", "rep_kinds"),
    image("statuses", "rep_statuses"),
    image("languages", "rep_languages"),
    image("sizes", "rep_sizes"),
    image("aspect", "rep_aspect"),
    image("durations", "rep_durations"),
    image("albums", "rep_albums"),
  );

  parts.push(
    ...section("rep_sources", "rep_intro_sources"),
    image("added_via", "rep_added_via"),
    image("added_month", "rep_added_month"),
    image("origin_kinds", "rep_origin_kinds"),
    image("origins_month", "rep_sources_month"),
    image("top_sources", "rep_top_sources"),
    a.origins.top.length > 0 &&
      table([tr("rep_source"), tr("rep_count"), tr("rep_uses")], a.origins.top.slice(0, 15).map((o) => [md(o.name), o.n, o.uses])),
  );

  parts.push(
    ...section(
      "rep_favorites",
      a.uses.since ? tr("rep_uses_since", { date: day(a.uses.since), never: a.uses.never, ready: a.uses.ready }) : "rep_no_uses",
    ),
    image("uses_day", "rep_uses_day"),
    a.uses.favorites.length > 0 &&
      `### ${tr("rep_favorite_list")}\n\n` + table([tr("rep_meme"), tr("rep_uses")], a.uses.favorites.slice(0, 10).map((f) => [md(f.title ?? "—"), f.n])),
    a.uses.forgotten.length > 0 &&
      !!a.uses.since &&
      `### ${tr("rep_forgotten_list")}\n\n` + table([tr("rep_meme"), tr("rep_saved")], a.uses.forgotten.slice(0, 10).map((f) => [md(f.title ?? "—"), day(f.created_at)])),
  );

  parts.push(
    ...section("rep_tags", "rep_intro_tags"),
    image("top_tags", "rep_top_tags"),
    a.tags.top.length > 0 && table([tr("rep_tag"), tr("rep_count")], a.tags.top.slice(0, 15).map((x) => [md(`#${x.tag}`), x.count])),
    image("cooc", "rep_cooc"),
    image("trend", "rep_tag_trend"),
    image("tags_per_meme", "rep_tags_per_meme"),
  );

  const c = a.spend.covered;
  parts.push(
    ...section("rep_spending", "rep_intro_spend"),
    c?.total > 0 &&
      table(
        [tr("rep_metric"), tr("rep_value")],
        [[tr("rep_spend"), usd(c.total)], ...(c.allowance ? [[tr("rep_allowance"), usd(c.allowance)]] : []), ...(c.balance ? [[tr("rep_balance"), usd(c.balance)]] : [])],
      ),
    image("spend_day", "rep_spend_day"),
    image("spend_total", "rep_spend_total"),
    image("spend_models", "rep_spend_models"),
    image("tokens", "rep_tokens_chart"),
    image("spend_keys", "rep_spend_keys"),
    image("cost_per_meme", "rep_cost_per_meme"),
    a.spend.models.length > 0 &&
      table(
        [tr("rep_model"), tr("rep_cost"), tr("rep_requests"), tr("rep_tokens")],
        a.spend.models.map((m) => [md(m.model), usd(m.cost), m.n, (m.prompt + m.completion).toLocaleString("en")]),
      ),
  );

  parts.push(...section("rep_map", "rep_intro_embeddings"), tr("rep_map_hint"), image("map_text", "rep_map_text"), image("map_image", "rep_map_image"));
  if (r.clusters.length) {
    const names = (ids: number[] = []) => ids.flatMap((i) => (r.clusters[i] ? [md(r.clusters[i].name ?? r.clusters[i].tags.slice(0, 3).join(", "))] : [])).join(", ");
    parts.push(
      `### ${tr("rep_trends")}`,
      image("interest_trend", "rep_trend_chart"),
      !!names(r.trends?.rising) && `**${tr("rep_rising")}:** ${names(r.trends?.rising)}`,
      !!names(r.trends?.fading) && `**${tr("rep_fading")}:** ${names(r.trends?.fading)}`,
      `### ${tr("rep_clusters")}`,
      table(
        ["#", tr("rep_cluster"), tr("rep_count"), tr("rep_tags")],
        r.clusters.slice(0, 30).map((c) => [c.id + 1, md(c.name ? `${c.name}${c.summary ? ` — ${c.summary}` : ""}` : "—"), c.size, md(c.tags.slice(0, 5).join(", "))]),
      ),
      !r.clusters.some((c) => c.name) && `_${tr("rep_no_names")}_`,
    );
  }
  if (r.moods) {
    const k = r.moods.top[0];
    const name = k >= 0 ? `${r.moods.emoji[k]} ${(r.moods.names[lang] ?? r.moods.keys)[k]}` : null;
    parts.push(`### ${tr("rep_moods")}`, tr("rep_moods_text"), !!name && `**${tr("rep_mood_year")}:** ${md(name)}`, image("moods", "rep_moods_chart"), image("mood_months", "rep_mood_months"));
  }
  parts.push(
    image("tag_map", "rep_tag_map"),
    `### ${tr("rep_similarity")}`,
    tr("rep_similarity_text", { dups: r.duplicates.length, outliers: r.outliers.length }),
    r.duplicates.length > 0 &&
      `#### ${tr("rep_duplicates_list")}\n\n` +
        table([tr("rep_meme"), tr("rep_meme"), tr("rep_similarity_col")], r.duplicates.slice(0, 10).map(([x, y, sim]) => [title(x), title(y), sim.toFixed(3)])),
    r.outliers.length > 0 && `#### ${tr("rep_outliers_list")}\n\n` + r.outliers.slice(0, 10).map((id) => `- ${title(id)}`).join("\n"),
    image("similarity", "rep_similarity_chart"),
    image("alignment", "rep_alignment"),
    (r.alignment?.worst.length ?? 0) > 0 &&
      `#### ${tr("rep_worst_list")}\n\n` +
        table([tr("rep_meme"), tr("rep_similarity_col")], r.alignment!.worst.slice(0, 10).map(([id, sim]) => [title(id), sim.toFixed(3)])),
    image("pca", "rep_pca"),
    "---",
    tr("rep_footer"),
  );
  return parts.filter(Boolean).join("\n\n");
}

/** Queue job: sends the report of a finished analysis to the user's bot chat. */
export async function sendReport(env: Env, analysisId: string, msgId?: number) {
  const a = await env.DB.prepare("SELECT * FROM analyses WHERE id = ? AND status = 'done'").bind(analysisId).first<Analysis>();
  const user = a && (await getUser(env.DB, a.user_id));
  const obj = a && (await env.MEDIA.get(resultKey(a.id)));
  if (!a || !user || !obj) return;
  const result = await obj.json<Result>();
  const lang = await userLang(env.DB, user.id);
  result.titles = await memeTitles(env.DB, user.id, [
    ...result.duplicates.slice(0, 10).flatMap(([a, b]) => [a, b]),
    ...result.outliers.slice(0, 10),
    ...(result.alignment?.worst ?? []).slice(0, 10).map(([id]) => id),
  ]);

  const img = charts(result.images);
  const markdown = reportMarkdown(lang, result, (name, caption) => img.image(name, t(lang, caption)));
  const media = await img.media(env, a.id);
  const app = { text: t(lang, "app_button"), web_app: { url: `${env.PUBLIC_URL.replace(/\/$/, "")}/` } };
  const replyTo = msgId ?? a.status_msg_id;
  await botApi(env.BOT_TOKEN).sendRichMessage(user.id, { markdown, media }, {
    reply_markup: { inline_keyboard: [[app]] },
    ...(replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
  });
}

/** Rendered chart PNGs of an analysis for a rich message: `image` returns the Markdown block of one (or ""), `media` loads those used. */
export function charts(rendered: string[] = []) {
  const used: string[] = [];
  return {
    image: (name: string, caption: string) => {
      if (!rendered.includes(name) || used.length >= 50) return "";
      used.push(name);
      return `![](tg://photo?id=${name} "${caption.replace(/"/g, "'")}")`;
    },
    async media(env: Env, id: string) {
      const media: InputRichMessageMedia[] = [];
      for (const name of used) {
        const png = await env.MEDIA.get(imageKey(id, name));
        if (png) media.push({ id: name, media: { type: "photo", media: new InputFile(new Uint8Array(await png.arrayBuffer()), `${name}.png`) } });
      }
      return media;
    },
  };
}

/** The report job gave up: tells the chat why. */
export async function reportFailed(env: Env, analysisId: string, error: unknown) {
  const a = await env.DB.prepare("SELECT * FROM analyses WHERE id = ?").bind(analysisId).first<Analysis>();
  if (a) await failedReport(env, { ...a, error: String(error) });
}

/** Titles of the user's memes by id (for the lists in the report). */
async function memeTitles(db: D1Database, userId: number, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 90);
  if (!unique.length) return {};
  const { results } = await db
    .prepare(`SELECT id, title FROM memes WHERE user_id = ? AND id IN (${unique.map(() => "?").join(",")})`)
    .bind(userId, ...unique)
    .all<{ id: string; title: string | null }>();
  return Object.fromEntries(results.map((m) => [m.id, m.title ?? ""]));
}

/** Tells the bot chat that the analysis failed. */
export async function failedReport(env: Env, a: Analysis) {
  const lang = await userLang(env.DB, a.user_id);
  const reply = a.status_msg_id ? { reply_parameters: { message_id: a.status_msg_id, allow_sending_without_reply: true } } : {};
  await botApi(env.BOT_TOKEN)
    .sendMessage(a.user_id, t(lang, "analysis_failed", { error: (a.error ?? "").slice(0, 300).replace(/[<>&]/g, "") }), { parse_mode: "HTML", ...reply })
    .catch(console.error);
}
