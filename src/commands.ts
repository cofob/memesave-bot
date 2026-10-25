import type { Composer } from "grammy";
import type { Message } from "grammy/types";
import type { Ctx } from "./bot";
import { MODELS } from "./config";
import { deleteMeme, type User } from "./db";
import type { Env } from "./env";
import { EMOJI, esc, t, usd, type Lang } from "./i18n";
import { oauthUrl, setUserKey } from "./userkey";
import { allStats, userStats } from "./stats";
import { batchProgress, cancelImport, collectingImport, countMemes, finishImport, retryFailed, startImport } from "./batch";
import { createZipImport, setZipStatusMessage } from "./zip";

const html = { parse_mode: "HTML" } as const;

/** file_unique_ids of the media in a message (all photo sizes, so any of them matches). */
export function mediaUniqueIds(msg: Message): string[] {
  if (msg.photo) return msg.photo.map((p) => p.file_unique_id);
  const file = msg.animation ?? msg.video;
  return file ? [file.file_unique_id] : [];
}

function settingsKeyboard(user: User, lang: Lang) {
  const button = (mode: User["search_mode"]) => ({
    text: t(lang, mode === "advanced" ? "mode_advanced" : "mode_fast"),
    callback_data: `mode:${mode}`,
    ...(user.search_mode === mode ? { icon_custom_emoji_id: EMOJI.done[0] } : {}),
  });
  return { inline_keyboard: [[button("advanced"), button("fast")]] };
}

async function statsText(env: Env, user: User, lang: Lang) {
  const st = await userStats(env, user);
  let text = t(lang, "stats", {
    ...st,
    spend: usd(st.spend),
    global: usd(st.global),
    own: usd(st.own),
    spend30: usd(st.spend30),
    avg: usd(st.avg),
    kinds: "",
  });
  if (st.kinds.length) text += t(lang, "stats_kinds", { lines: st.kinds.map((k) => `${k.kind}: ${usd(k.cost)} (${k.count})`).join("\n") });
  return text;
}

async function allStatsText(env: Env, lang: Lang) {
  const all = await allStats(env);
  const lines = all.users.map(
    (u) => `<code>${u.id}</code> ${u.username ? "@" + esc(u.username) : ""} — ${u.memes} memes, ${usd(u.total_cost)} (bot key ${usd(u.global)})`,
  );
  return t(lang, "stats_all", { lines: lines.join("\n"), spend: `${usd(all.total)} (bot key ${usd(all.global)})` });
}

async function replyKey(ctx: Ctx, env: Env) {
  const connect = { text: t(ctx.lang, "key_connect"), url: await oauthUrl(env, ctx.user.id) };
  const has = ctx.user.openrouter_key !== null;
  const row = has ? [connect, { text: t(ctx.lang, "key_remove"), callback_data: "key:remove" }] : [connect];
  await ctx.reply(t(ctx.lang, has ? "key_set" : "key_none"), { ...html, reply_markup: { inline_keyboard: [row] } });
}

export function registerCommands<C extends Ctx>(bot: Composer<C>, env: Env) {
  bot.command("start", async (ctx) => {
    if (ctx.match === "key_failed") {
      await ctx.reply(t(ctx.lang, "key_failed"), html);
      return replyKey(ctx, env);
    }
    const app = { text: t(ctx.lang, "app_button"), web_app: { url: `${env.PUBLIC_URL.replace(/\/$/, "")}/` } };
    await ctx.reply(t(ctx.lang, "start", { bot: ctx.me.username, role: ctx.user.role }), { ...html, reply_markup: { inline_keyboard: [[app]] } });
  });

  bot.command("help", (ctx) =>
    ctx.reply(t(ctx.lang, "help") + (ctx.user.role === "admin" ? t(ctx.lang, "help_admin") : ""), html),
  );

  bot.command("about", (ctx) =>
    ctx.reply(
      t(ctx.lang, "about", { embed: MODELS.embed, image: MODELS.describeImage, video: MODELS.describeVideo, search: MODELS.search }),
      html,
    ),
  );

  bot.command("stats", async (ctx) => {
    const all = ctx.match.trim() === "all" && ctx.user.role === "admin";
    await ctx.reply(all ? await allStatsText(env, ctx.lang) : await statsText(env, ctx.user, ctx.lang), html);
  });

  bot.command("delete", async (ctx) => {
    const reply = ctx.msg.reply_to_message;
    const ids = reply ? mediaUniqueIds(reply) : [];
    if (!ids.length) return ctx.reply(t(ctx.lang, "delete_hint"), html);
    const meme = await env.DB.prepare(
      `SELECT id FROM memes WHERE user_id = ? AND file_unique_id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(ctx.user.id, ...ids)
      .first<{ id: string }>();
    if (!meme) return ctx.reply(t(ctx.lang, "delete_not_found"), html);
    await deleteMeme(env, meme.id);
    await ctx.reply(t(ctx.lang, "deleted"), html);
  });

  bot.command("settings", (ctx) =>
    ctx.reply(t(ctx.lang, "settings"), { ...html, reply_markup: settingsKeyboard(ctx.user, ctx.lang) }),
  );

  bot.command("key", (ctx) => replyKey(ctx, env));

  bot.command("batch", async (ctx) => {
    const { created, count } = await startImport(env.DB, ctx.user.id);
    await ctx.reply(created ? t(ctx.lang, "batch_started") : t(ctx.lang, "batch_open", { n: count }), html);
  });

  bot.command("batch_finish", async (ctx) => {
    const id = await collectingImport(env.DB, ctx.user.id);
    if (!id) return ctx.reply(t(ctx.lang, "batch_off"), html);
    const msg = await ctx.reply(t(ctx.lang, "batch_finishing", { n: await countMemes(env.DB, id) }), html);
    await finishImport(env, ctx.user.id, msg.message_id);
  });

  bot.command("batch_status", async (ctx) => {
    const { collecting, recent, failed } = await batchProgress(env, ctx.user.id);
    if (!collecting && !recent.length && !failed) return ctx.reply(t(ctx.lang, "batch_status_none"), html);
    const lines = [t(ctx.lang, "batch_status_title")];
    if (collecting) lines.push(t(ctx.lang, "batch_status_collecting", { n: collecting.photos }));
    for (const { live, ...r } of recent) {
      const date = new Date(r.created_at * 1000).toISOString().slice(0, 16).replace("T", " ");
      lines.push(t(ctx.lang, "batch_status_row", { ...r, date, cost: usd(r.cost) }));
      if (live) lines.push(t(ctx.lang, "batch_status_live", live));
    }
    if (failed) lines.push(t(ctx.lang, "batch_status_failed", { n: failed }));
    await ctx.reply(lines.join("\n"), html);
  });

  bot.command("batch_retry", async (ctx) => {
    const failed = (await batchProgress(env, ctx.user.id)).failed;
    if (!failed) return ctx.reply(t(ctx.lang, "batch_retry_none"), html);
    const msg = await ctx.reply(t(ctx.lang, "batch_retry_started", { photos: "…", others: "…" }), html);
    const { photos, others } = await retryFailed(env, ctx.user.id, msg.message_id);
    await ctx.api.editMessageText(ctx.chat.id, msg.message_id, t(ctx.lang, "batch_retry_started", { photos, others }), html).catch(() => {});
  });

  bot.command("batch_zip", async (ctx) => {
    const zip = await createZipImport(env, ctx.user.id, ctx.lang);
    const msg = await ctx.reply(zip.text, { ...html, reply_markup: { inline_keyboard: [[zip.button]] } });
    await setZipStatusMessage(env.DB, zip.id, msg.message_id);
  });

  bot.command("batch_cancel", async (ctx) => {
    const n = await cancelImport(env, ctx.user.id);
    await ctx.reply(n === null ? t(ctx.lang, "batch_off") : t(ctx.lang, "batch_cancelled", { n }), html);
  });

  bot.callbackQuery("key:remove", async (ctx) => {
    await setUserKey(env, ctx.user.id, null);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t(ctx.lang, "key_removed"), html).catch(() => {});
  });

  bot.callbackQuery(/^mode:(advanced|fast)$/, async (ctx) => {
    const mode = ctx.match[1] as User["search_mode"];
    await env.DB.prepare("UPDATE users SET search_mode = ? WHERE id = ?").bind(mode, ctx.user.id).run();
    await ctx.answerCallbackQuery(t(ctx.lang, "mode_saved"));
    await ctx.editMessageReplyMarkup({ reply_markup: settingsKeyboard({ ...ctx.user, search_mode: mode }, ctx.lang) }).catch(() => {});
  });
}
