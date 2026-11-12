import type { Composer } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { Ctx } from "./bot";
import { startPairAnalysis } from "./analysis";
import { allowAi } from "./billingbot";
import { botApi } from "./botapi";
import { canUseAi } from "./billing";
import { getUser, userLang } from "./db";
import type { Env } from "./env";
import { esc, t, type Lang } from "./i18n";
import { pairButton } from "./feedbot";
import { acceptPair, createInvite, declinePair, endPair, getPair, listPairs, openInvite, setShares, type Pair, type PairView } from "./pairs";
import { sendCard, sendPairsList, sendQuiz, statsButton, updateCard } from "./pairwidget";

const html = { parse_mode: "HTML" } as const;
let username: string | undefined;
/** Bot username (without @) for t.me links. */
export const botName = async (env: Env) => (username ??= (await botApi(env.BOT_TOKEN).getMe()).username);
export const inviteLink = (bot: string, id: string) => `https://t.me/${bot}?start=pair_${id}`;

const who = (lang: Lang, p: PairView) => p.partner.name ?? (p.partner.username ? `@${p.partner.username}` : t(lang, "pair_btn_link"));

/** The consent card for the invited user. */
const consent = (lang: Lang, id: string) => ({
  ...html,
  reply_markup: {
    inline_keyboard: [[
      { text: t(lang, "pair_btn_accept"), callback_data: `pair:ok:${id}` },
      { text: t(lang, "pair_btn_decline"), callback_data: `pair:no:${id}` },
    ]],
  },
});
const linkCard = (lang: Lang, link: string) => ({
  ...html,
  reply_markup: { inline_keyboard: [[{ text: t(lang, "pair_btn_forward"), url: `https://t.me/share/url?url=${encodeURIComponent(link)}` }]] },
});
const PICK_ID = 1;
/** Telegram's user picker: a reply keyboard button here, a prepared button in the Mini App (WebApp.requestChat). */
export const pickButton = (lang: Lang) => ({
  text: t(lang, "pair_btn_choose"),
  request_users: { request_id: PICK_ID, user_is_bot: false, max_quantity: 1, request_name: true, request_username: true },
});
// The first reply keyboard of the bot.
const picker = (lang: Lang) => ({
  ...html,
  reply_markup: {
    keyboard: [[pickButton(lang)]],
    one_time_keyboard: true,
    resize_keyboard: true,
  },
});
const noKeyboard = { ...html, reply_markup: { remove_keyboard: true } } as const;

const answerMarkup = (env: Env, lang: Lang, name: string, id: string, ok: boolean) => ({
  ...html,
  reply_markup: { inline_keyboard: ok ? [[statsButton(env, t(lang, "pair_btn_stats", { name }), id)]] : [] },
});

/** The invited user answered (bot or app): the inviter hears back; on yes both get the card and the analysis starts, paid by the inviter. */
export async function pairAnswered(env: Env, p: Pair, ok: boolean, name: string) {
  const lang = await userLang(env.DB, p.a);
  await botApi(env.BOT_TOKEN).sendMessage(p.a, t(lang, ok ? "pair_accepted_inviter" : "pair_declined_inviter", { name: esc(name) }), answerMarkup(env, lang, name, p.id, ok)).catch(console.error);
  if (!ok) return;
  await sendCard(env, p, p.a, lang);
  await sendCard(env, p, p.b!, await userLang(env.DB, p.b!));
  const inviter = await getUser(env.DB, p.a);
  // Too few memes on a side: no run; the stats page offers it later.
  if (inviter) await startPairAnalysis(env, p.id, p.a, { llm: (await canUseAi(env.DB, inviter)).ok, chat: true }).catch(console.error);
}

/** A pair was ended (bot or app): the card says so and the other side is told. */
export async function pairEnded(env: Env, p: Pair, by: number) {
  await updateCard(env, p, true);
  const other = by === p.a ? p.b : p.a;
  if (p.status !== "active" || !other) return;
  const lang = await userLang(env.DB, other);
  await botApi(env.BOT_TOKEN).sendMessage(other, t(lang, "pair_ended_by", { name: esc((by === p.a ? p.a_name : p.b_name) ?? "?") }), html).catch(console.error);
}

/** Invites the picked user: the consent card to them, or the link to the inviter when they never started the bot. */
async function invite(ctx: Ctx, env: Env, userId: number, firstName: string | null, extra: object) {
  if (userId === ctx.user.id) return ctx.reply(t(ctx.lang, "pair_self"), extra);
  const name = esc(firstName ?? String(userId));
  const p = await createInvite(env.DB, ctx.user.id, ctx.from!.first_name, userId, firstName);
  if (!p) return ctx.reply(t(ctx.lang, "pair_limit"), extra);
  if (p.status === "active" || p.a !== ctx.user.id) return ctx.reply(t(ctx.lang, "pair_exists", { name }), extra);
  const lang = await userLang(env.DB, userId);
  // Telegram refuses (403, or 400 "chat not found") when the partner never started the bot: they get the link instead.
  const sent = await ctx.api.sendMessage(userId, t(lang, "pair_invite", { name: esc(ctx.from!.first_name) }), consent(lang, p.id)).then(
    () => true,
    () => false,
  );
  if (sent) return ctx.reply(t(ctx.lang, "pair_sent", { name }), extra);
  await ctx.reply(t(ctx.lang, "pair_not_started", { name }), extra);
  const link = inviteLink(ctx.me.username, p.id);
  await ctx.reply(t(ctx.lang, "pair_link", { link }), linkCard(ctx.lang, link));
}

async function pairsCard(env: Env, userId: number, lang: Lang) {
  const pairs = await listPairs(env.DB, userId);
  const rows: InlineKeyboardButton[][] = [];
  const lines = pairs.map((p) => {
    const name = who(lang, p);
    if (p.status === "active") {
      rows.push([statsButton(env, t(lang, "pair_btn_stats", { name }), p.id), { text: t(lang, "pair_btn_card"), callback_data: `pair:card:${p.id}` }, { text: t(lang, "pair_btn_analysis"), callback_data: `pair:run:${p.id}` }]);
      rows.push([
        pairButton(p.id, "mix", t(lang, "pair_btn_feed")),
        { text: t(lang, "pair_btn_quiz"), callback_data: `pair:quiz:${p.id}` },
        { text: t(lang, p.i_share ? "pair_btn_hide" : "pair_btn_show"), callback_data: `pair:share:${p.id}:${p.i_share ? 0 : 1}` },
        { text: t(lang, "pair_btn_end"), callback_data: `pair:end:${p.id}` },
      ]);
      return t(lang, "pair_line_active", { name: esc(name) }) + (p.i_share ? "" : t(lang, "pair_line_hidden"));
    }
    if (p.incoming) rows.push(consent(lang, p.id).reply_markup.inline_keyboard[0]);
    else rows.push([{ text: t(lang, "pair_btn_cancel", { name }), callback_data: `pair:end!:${p.id}` }]);
    return t(lang, p.incoming ? "pair_line_incoming" : "pair_line_waiting", { name: esc(name) });
  });
  rows.push([{ text: t(lang, "pair_btn_pick"), callback_data: "pair:pick" }, { text: t(lang, "pair_btn_link"), callback_data: "pair:link" }]);
  return { text: lines.length ? t(lang, "pair_list", { lines: lines.join("\n") }) : t(lang, "pair_none"), reply_markup: { inline_keyboard: rows } };
}

/** /start pair (the user picker) and /start pair_<id> (the consent card of an invite link). */
export async function pairStart(ctx: Ctx, env: Env, payload: string) {
  if (payload === "pair") return ctx.reply(t(ctx.lang, "pair_pick"), picker(ctx.lang));
  const p = await openInvite(env.DB, payload.slice(5), ctx.user.id);
  return p ? ctx.reply(t(ctx.lang, "pair_invite", { name: esc(p.a_name ?? "?") }), consent(ctx.lang, p.id)) : ctx.reply(t(ctx.lang, "pair_gone"), html);
}

export function registerPairs<C extends Ctx>(bot: Composer<C>, env: Env) {
  bot.command("pair", async (ctx) => {
    await sendPairsList(env, ctx.user.id, ctx.lang); // the widget above the text card with the buttons
    const card = await pairsCard(env, ctx.user.id, ctx.lang);
    await ctx.reply(card.text, { ...html, reply_markup: card.reply_markup });
  });
  bot.callbackQuery("pair:pick", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.lang, "pair_pick"), picker(ctx.lang));
  });
  bot.callbackQuery("pair:link", async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await createInvite(env.DB, ctx.user.id, ctx.from.first_name);
    if (!p) return ctx.reply(t(ctx.lang, "pair_limit"), html);
    const link = inviteLink(ctx.me.username, p.id);
    await ctx.reply(t(ctx.lang, "pair_link", { link }), linkCard(ctx.lang, link));
  });

  bot.on("message:users_shared", async (ctx) => {
    const u = ctx.msg.users_shared.users[0];
    if (!u || ctx.msg.users_shared.request_id !== PICK_ID) return;
    await invite(ctx, env, u.user_id, u.first_name ?? u.username ?? null, noKeyboard);
  });
  // A contact card from the attachment menu: asks first, a contact may be sent for another reason.
  bot.on("message:contact", async (ctx) => {
    const c = ctx.msg.contact;
    if (!c.user_id) return ctx.reply(t(ctx.lang, "pair_contact_unknown"), html);
    const yes = [[{ text: t(ctx.lang, "pair_btn_invite", { name: c.first_name }), callback_data: `pair:inv:${c.user_id}` }]];
    await ctx.reply(t(ctx.lang, "pair_contact_ask", { name: esc(c.first_name) }), { ...html, reply_markup: { inline_keyboard: yes } });
  });
  bot.callbackQuery(/^pair:inv:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => {});
    await invite(ctx, env, Number(ctx.match[1]), null, html);
  });

  bot.callbackQuery(/^pair:(ok|no):([\w-]{12})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, act, id] = ctx.match;
    const [ok, name] = [act === "ok", ctx.from.first_name];
    const p = ok ? await acceptPair(env.DB, id, ctx.user.id, name) : await declinePair(env.DB, id, ctx.user.id);
    if (ok && !p) return ctx.editMessageText(t(ctx.lang, "pair_gone"), html).catch(() => {});
    const inviter = p?.a_name ?? "?";
    await ctx.editMessageText(t(ctx.lang, ok ? "pair_accepted" : "pair_declined", { name: esc(inviter) }), answerMarkup(env, ctx.lang, inviter, id, ok)).catch(() => {});
    if (p) await pairAnswered(env, p, ok, name); // an open link declined by a stranger stays open
  });

  bot.callbackQuery(/^pair:quiz:([\w-]{12})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await env.DB.prepare("SELECT * FROM pairs WHERE id = ?1 AND status = 'active' AND (a = ?2 OR b = ?2)").bind(ctx.match[1], ctx.user.id).first<Pair>();
    if (p) await sendQuiz(env, p, ctx.user.id, ctx.lang);
  });

  bot.callbackQuery(/^pair:card:([\w-]{12})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await env.DB.prepare("SELECT * FROM pairs WHERE id = ?1 AND status = 'active' AND (a = ?2 OR b = ?2)").bind(ctx.match[1], ctx.user.id).first<Pair>();
    if (!p) return;
    await updateCard(env, p);
    await sendCard(env, p, ctx.user.id, ctx.lang);
  });

  bot.callbackQuery(/^pair:share:([\w-]{12}):([01])$/, async (ctx) => {
    const p = await setShares(env.DB, ctx.match[1], ctx.user.id, ctx.match[2] === "1");
    await ctx.answerCallbackQuery(t(ctx.lang, p ? "mode_saved" : "pair_gone"));
    if (p?.status === "active") await updateCard(env, p);
    const card = await pairsCard(env, ctx.user.id, ctx.lang);
    await ctx.editMessageText(card.text, { ...html, reply_markup: card.reply_markup }).catch(() => {});
  });
  bot.callbackQuery(/^pair:run:([\w-]{12})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const run = (llm: "llm" | "plain") => ({ text: t(ctx.lang, `analysis_run_${llm}`), callback_data: `pair:run:${ctx.match[1]}:${llm}` });
    await ctx.reply(t(ctx.lang, "pair_analysis_ask"), { ...html, reply_markup: { inline_keyboard: [[run("llm"), run("plain")]] } });
  });
  bot.callbackQuery(/^pair:run:([\w-]{12}):(llm|plain)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const llm = ctx.match[2] === "llm";
    if (llm && !(await allowAi(env, ctx))) return;
    const run = await startPairAnalysis(env, ctx.match[1], ctx.user.id, { llm, chat: true, msgId: ctx.callbackQuery.message?.message_id });
    const key = !run ? "pair_gone" : run === "pair_too_small" ? run : run.status === "done" ? "analysis_cached" : "pair_analysis_started";
    await ctx.editMessageText(t(ctx.lang, key), html).catch(() => {});
  });
  bot.callbackQuery(/^pair:end:([\w-]{12})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await getPair(env.DB, ctx.user.id, ctx.match[1]);
    if (!p) return;
    const yes = [[{ text: t(ctx.lang, "pair_btn_end_yes"), callback_data: `pair:end!:${p.id}` }]];
    await ctx.reply(t(ctx.lang, "pair_end_ask", { name: esc(who(ctx.lang, p)) }), { ...html, reply_markup: { inline_keyboard: yes } });
  });
  bot.callbackQuery(/^pair:end!:([\w-]{12})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const p = await endPair(env.DB, ctx.match[1], ctx.user.id);
    if (p) await pairEnded(env, p, ctx.user.id);
    await ctx.editMessageText(t(ctx.lang, "pair_ended"), html).catch(() => {});
  });
}
