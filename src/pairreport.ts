// Bot report of a pair analysis: one rich message to each member in their language, with the pair_* charts.
import { resultKey, type Analysis } from "./analysis";
import { charts, md, table } from "./analysisreport";
import { botApi } from "./botapi";
import { userLang } from "./db";
import type { Env } from "./env";
import { t, type Key, type Lang } from "./i18n";
import type { PairResult } from "./pairfacts";

/** The report Markdown in `lang`; `image(name, caption)` returns the media block of a rendered chart or "". */
export function pairMarkdown(lang: Lang, r: PairResult, image: (name: string, caption: Key) => string, showPorn = false) {
  const tr = (k: Key, p: Record<string, string | number> = {}) => t(lang, k, p);
  const names = [r.analytics.me.name ?? "A", r.analytics.partner.name ?? "B"].map(md);
  const f = r.facts?.[lang];
  const shared = r.clusters.filter((c) => c.type === "shared").slice(0, 8);
  const m = r.moods;
  const mood = (o: number) => (m && m.top[o] >= 0 ? `${m.emoji[m.top[o]]} ${md(m.names[lang]?.[m.top[o]] ?? m.keys[m.top[o]])}` : "—");
  const porn = showPorn ? r.analytics.porn : null;
  const pct = (x: { porn: number; ready: number } | null) => Math.round((100 * (x?.porn ?? 0)) / Math.max(1, x?.ready ?? 0));
  const parts: (string | false | undefined)[] = [
    `# ${md(f?.title || tr("prep_title"))}`,
    `**${tr("prep_compat", { n: r.scores.compat })}**`,
    f && md(f.verdict),
    image("pair_map", "prep_map"),
    !!f?.facts.length && `## ${tr("prep_facts")}\n\n` + f.facts.map((x) => `- ${md(x)}`).join("\n"),
    !!f?.awards.length &&
      `## ${tr("prep_awards")}\n\n` +
        table([tr("prep_award"), tr("prep_winner"), tr("prep_reason")], f.awards.map((w) => [md(w.name), w.winner === "both" ? tr("prep_both") : names[+(w.winner === "b")], md(w.reason)])),
    `## ${tr("prep_twins")}`,
    tr("prep_twins_text", { n: r.twins.length, a: names[0], b: names[1], na: r.influence.twins[0], nb: r.influence.twins[1] }),
    shared.length > 0 &&
      `## ${tr("prep_shared")}\n\n` + table([tr("rep_cluster"), names[0], names[1]], shared.map((c) => [md(c.name ?? c.tags.slice(0, 3).join(", ")), c.share[0], c.share[1]])),
    image("pair_clusters", "prep_clusters_chart"),
    !!m && `## ${tr("prep_moods")}\n\n- ${names[0]}: ${mood(0)}\n- ${names[1]}: ${mood(1)}`,
    image("pair_moods", "prep_moods_chart"),
    image("pair_hours", "prep_hours"),
    !!porn &&
      `## ${tr("prep_porn")}\n\n` +
        tr("prep_porn_text", {
          a: names[0],
          pa: pct(porn.me),
          b: names[1],
          pb: pct(porn.partner),
          j: Math.round(100 * porn.jaccard),
          n: porn.twins.count,
          na: porn.twins.first.me,
          nb: porn.twins.first.partner,
        }),
    !!porn && image("pair_porn_tags", "prep_porn_tags"),
    "---",
    tr("prep_footer"),
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Queue job: sends the report of a finished pair analysis to both members; one who blocked the bot does not stop the other. */
export async function sendPairReport(env: Env, analysisId: string, msgId?: number, only?: number) {
  const a = await env.DB.prepare("SELECT * FROM analyses WHERE id = ? AND status = 'done' AND pair_id IS NOT NULL").bind(analysisId).first<Analysis>();
  const obj = a && (await env.MEDIA.get(resultKey(a.id)));
  if (!a || !obj) return;
  const r = await obj.json<PairResult>();
  const hidden = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE hide_porn = 1 AND id IN (${(r.owners ?? []).map(() => "?").join(",")})`).bind(...(r.owners ?? [])).first<number>("n");
  const url = `${env.PUBLIC_URL.replace(/\/$/, "")}/?pair=${a.pair_id}`;
  const sent = await Promise.allSettled(
    (r.owners ?? []).filter((id) => !only || id === only).map(async (id) => {
      const lang = await userLang(env.DB, id);
      const img = charts(r.images);
      const markdown = pairMarkdown(lang, r, (name, caption) => img.image(name, t(lang, caption)), !hidden);
      const replyTo = id === a.user_id && (msgId ?? a.status_msg_id);
      await botApi(env.BOT_TOKEN).sendRichMessage(id, { markdown, media: await img.media(env, a.id) }, {
        reply_markup: { inline_keyboard: [[{ text: t(lang, "prep_open"), web_app: { url } }]] },
        ...(replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
      });
    }),
  );
  const failed = sent.filter((x) => x.status === "rejected");
  for (const x of failed) console.warn("pair report failed", analysisId, x.reason);
  if (failed.length && failed.length === sent.length) throw failed[0].reason; // nobody got it: the queue retries
}
