import type { Api, Bot, Composer } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import {
  allowanceLeft,
  applyPayment,
  canUseAi,
  date,
  expectedStars,
  isActive,
  isFree,
  money,
  ownKey,
  paymentText,
  planUsd,
  starsFor,
  starsInvoiceLink,
  starsPaymentUsd,
  subscribeButton,
  topupButton,
  type Gate,
  type ProductKind,
  type StarsPayload,
} from "./billing";
import type { Ctx } from "./bot";
import { CRYPTO_TOPUPS, MONTHLY_ALLOWANCE, STAR_TOPUPS, STAR_USD } from "./config";
import { btcpayOn, createBtcpayInvoice, productUsd, usdtNetworks } from "./crypto";
import type { User } from "./db";
import type { Env } from "./env";
import { t, type Lang } from "./i18n";

// Telegram UI for billing: /subscribe, /balance, payment methods, Stars payment updates, the AI gate.

const html = { parse_mode: "HTML" } as const;
const kb = (rows: InlineKeyboardButton[][]) => ({ inline_keyboard: rows.filter((r) => r.length) });

function statusLine(u: User, lang: Lang) {
  if (isFree(u)) return t(lang, "bill_status_free");
  if (!isActive(u)) return t(lang, "bill_status_none");
  const renew = u.plan === "monthly" && u.sub_charge_id ? t(lang, u.sub_state === "active" ? "bill_renew_on" : "bill_renew_off") : "";
  return t(lang, "bill_status_active", { date: date(u.paid_until!, lang), renew });
}

/** Plan card: prices, Stars invoice links, crypto methods, top-up and auto-renew buttons. */
export async function subscribeCard(env: Env, api: Api, u: User, lang: Lang) {
  const byok = ownKey(u);
  const [m, y] = [planUsd("monthly", byok), planUsd("yearly", byok)];
  const text = t(lang, "bill_subscribe", {
    m_usd: money(m),
    m_stars: starsFor(m),
    y_usd: money(y),
    y_stars: starsFor(y),
    included: byok ? t(lang, "bill_included_byok") : t(lang, "bill_included_std", { allowance: money(MONTHLY_ALLOWANCE) }),
    status: statusLine(u, lang),
  });
  if (isFree(u)) return { text, reply_markup: kb([]) };
  const [monthly, yearly] = await Promise.all([starsInvoiceLink(api, u, lang, "monthly"), starsInvoiceLink(api, u, lang, "yearly")]);
  const renew: InlineKeyboardButton[] =
    u.plan === "monthly" && u.sub_charge_id && isActive(u)
      ? [u.sub_state === "active"
          ? { text: t(lang, "bill_btn_cancel_renew"), callback_data: "bill:renew:off" }
          : { text: t(lang, "bill_btn_resume_renew"), callback_data: "bill:renew:on" }]
      : [];
  return {
    text,
    reply_markup: kb([
      [{ text: t(lang, "bill_btn_stars_monthly", { stars: starsFor(m) }), url: monthly }, { text: t(lang, "bill_btn_stars_yearly", { stars: starsFor(y) }), url: yearly }],
      btcpayOn(env)
        ? [{ text: t(lang, "bill_btn_btcpay_monthly", { usd: money(m) }), callback_data: "bill:btc:monthly" }, { text: t(lang, "bill_btn_btcpay_yearly", { usd: money(y) }), callback_data: "bill:btc:yearly" }]
        : [],
      usdtNetworks(env).length
        ? [{ text: t(lang, "bill_btn_usdt_monthly", { usd: money(m) }), callback_data: "bill:usdt:monthly" }, { text: t(lang, "bill_btn_usdt_yearly", { usd: money(y) }), callback_data: "bill:usdt:yearly" }]
        : [],
      [topupButton(lang)],
      renew,
    ]),
  };
}

/** Top-up menu: Stars sizes (invoice links) and crypto sizes. */
export async function topupCard(env: Env, api: Api, u: User, lang: Lang) {
  const links = await Promise.all(STAR_TOPUPS.map((s) => starsInvoiceLink(api, u, lang, "topup", s)));
  const stars = STAR_TOPUPS.map((s, i) => ({ text: t(lang, "bill_btn_topup_stars", { stars: s, usd: money(s * STAR_USD) }), url: links[i] }));
  const crypto = (key: "bill_btn_topup_btcpay" | "bill_btn_topup_usdt", prefix: string) =>
    CRYPTO_TOPUPS.map((x) => ({ text: t(lang, key, { usd: money(x) }), callback_data: `${prefix}:topup:${x}` }));
  return {
    text: t(lang, "bill_topup_choose", { rate: `$${STAR_USD}` }),
    reply_markup: kb([
      stars.slice(0, 2),
      stars.slice(2),
      btcpayOn(env) ? crypto("bill_btn_topup_btcpay", "bill:btc") : [],
      usdtNetworks(env).length ? crypto("bill_btn_topup_usdt", "bill:usdt") : [],
    ]),
  };
}

export async function balanceText(env: Env, u: User, lang: Lang) {
  return t(lang, "bill_balance_card", {
    status: statusLine(u, lang),
    left: money(await allowanceLeft(env.DB, u)),
    allowance: money(u.plan_byok ? 0 : MONTHLY_ALLOWANCE),
    balance: money(u.balance),
    own: t(lang, ownKey(u) ? "bill_yes" : "bill_no"),
  });
}

/** Gate message with the button that fixes it. */
export function gateReply(u: User, lang: Lang, reason: Exclude<Gate, { ok: true }>["reason"]) {
  const text =
    reason === "subscribe"
      ? t(lang, "bill_gate_subscribe", { price: money(planUsd("monthly", ownKey(u))), allowance: money(MONTHLY_ALLOWANCE) })
      : t(lang, "bill_gate_credit");
  return { text, reply_markup: kb([[reason === "subscribe" ? subscribeButton(lang) : topupButton(lang)]]) };
}

/** True when new AI work may start; otherwise replies with the gate message. */
export async function allowAi(env: Env, ctx: Ctx) {
  const gate = await canUseAi(env.DB, ctx.user);
  if (gate.ok) return true;
  const { text, reply_markup } = gateReply(ctx.user, ctx.lang, gate.reason);
  await ctx.reply(text, { ...html, reply_markup });
  return false;
}

/** Crypto checkout for a product: a BTCPay link; USDT asks for the network first. */
async function cryptoCheckout(env: Env, ctx: Ctx, provider: "btc" | "usdt", kind: ProductKind, topup: number | undefined, network?: string) {
  const amount = productUsd(kind, ownKey(ctx.user), topup);
  if (amount === null) return;
  try {
    if (provider === "usdt" && !network) {
      const suffix = kind === "topup" ? `:${amount}` : "";
      return ctx.reply(t(ctx.lang, "bill_usdt_choose"), {
        ...html,
        reply_markup: kb([usdtNetworks(env).map((c) => ({ text: c, callback_data: `bill:usdtn:${c}:${kind}${suffix}` }))]),
      });
    }
    const inv = await createBtcpayInvoice(env, ctx.user, kind, amount, network);
    const text = network ? t(ctx.lang, "bill_usdt_checkout", { usd: money(amount), network }) : t(ctx.lang, "bill_crypto_checkout", { usd: money(amount) });
    return ctx.reply(text, { ...html, reply_markup: kb([[{ text: t(ctx.lang, "bill_btn_open_checkout"), url: inv.url }]]) });
  } catch (e) {
    console.error("crypto checkout", e);
    return ctx.reply(t(ctx.lang, "bill_crypto_unavailable"), html);
  }
}

export function registerBilling<C extends Ctx>(bot: Composer<C>, env: Env) {
  const sendSubscribe = async (ctx: C) => {
    const card = await subscribeCard(env, ctx.api, ctx.user, ctx.lang);
    await ctx.reply(card.text, { ...html, reply_markup: card.reply_markup });
  };
  const sendTopup = async (ctx: C) => {
    const card = await topupCard(env, ctx.api, ctx.user, ctx.lang);
    await ctx.reply(card.text, { ...html, reply_markup: card.reply_markup });
  };

  bot.command("subscribe", sendSubscribe);
  bot.command("balance", async (ctx) =>
    ctx.reply(await balanceText(env, ctx.user, ctx.lang), { ...html, reply_markup: kb([[topupButton(ctx.lang), subscribeButton(ctx.lang)]]) }),
  );
  bot.command("paysupport", (ctx) =>
    ctx.reply(t(ctx.lang, "paysupport", { contact: `<a href="tg://user?id=${env.ADMIN_ID}">admin</a>` }), html),
  );
  bot.command("terms", (ctx) => ctx.reply(t(ctx.lang, "terms"), html));

  bot.callbackQuery("bill:subscribe", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendSubscribe(ctx);
  });
  bot.callbackQuery("bill:topup", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendTopup(ctx);
  });
  bot.callbackQuery(/^bill:(btc|usdt):(monthly|yearly|topup)(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, provider, kind, topup] = ctx.match;
    await cryptoCheckout(env, ctx, provider as "btc" | "usdt", kind as ProductKind, topup ? Number(topup) : undefined);
  });
  bot.callbackQuery(/^bill:usdtn:([\w-]+):(monthly|yearly|topup)(?::(\d+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, network, kind, topup] = ctx.match;
    await cryptoCheckout(env, ctx, "usdt", kind as ProductKind, topup ? Number(topup) : undefined, network);
  });
  bot.callbackQuery(/^bill:renew:(on|off)$/, async (ctx) => {
    const on = ctx.match[1] === "on";
    if (!ctx.user.sub_charge_id) return ctx.answerCallbackQuery();
    await ctx.api.editUserStarSubscription(ctx.user.id, ctx.user.sub_charge_id, !on);
    const state = on ? "active" : "canceled";
    await env.DB.prepare("UPDATE users SET sub_state = ? WHERE id = ?").bind(state, ctx.user.id).run();
    await ctx.answerCallbackQuery(t(ctx.lang, on ? "bill_renew_resumed" : "bill_renew_canceled", { date: date(ctx.user.paid_until ?? 0, ctx.lang) }).replace(/<[^>]+>/g, ""));
    const card = await subscribeCard(env, ctx.api, { ...ctx.user, sub_state: state }, ctx.lang);
    await ctx.editMessageText(card.text, { ...html, reply_markup: card.reply_markup }).catch(() => {});
  });
}

const parsePayload = (s: string): StarsPayload | null => {
  try {
    return JSON.parse(s) as StarsPayload;
  } catch {
    return null;
  }
};

/** Stars payments: pre-checkout validation, successful payments (incl. renewals), subscription state changes. */
export function registerPayments(bot: Bot<Ctx>, env: Env) {
  bot.on("pre_checkout_query", async (ctx) => {
    const q = ctx.preCheckoutQuery;
    const p = parsePayload(q.invoice_payload);
    const ok = !!p && p.u === q.from.id && q.currency === "XTR" && expectedStars(p) === q.total_amount;
    await ctx.answerPreCheckoutQuery(ok, ok ? undefined : { error_message: t(ctx.lang, "bill_precheckout_bad") });
  });

  bot.on("message:successful_payment", async (ctx) => {
    const sp = ctx.msg.successful_payment;
    const p = parsePayload(sp.invoice_payload);
    if (!p || sp.currency !== "XTR") return;
    const { applied, user } = await applyPayment(env.DB, {
      userId: ctx.from.id,
      method: "stars",
      kind: p.k,
      byok: !!p.b,
      usd: starsPaymentUsd(p),
      stars: sp.total_amount,
      chargeId: sp.telegram_payment_charge_id,
      recurring: !!sp.is_recurring && !sp.is_first_recurring,
      subChargeId: sp.is_first_recurring ? sp.telegram_payment_charge_id : undefined,
    });
    if (applied && user) await ctx.reply(paymentText(ctx.lang, p.k, user, starsPaymentUsd(p), !!sp.is_recurring && !sp.is_first_recurring), html);
  });

  bot.on("subscription", async (ctx) => {
    const { user: from, state } = ctx.update.subscription!;
    const u = await env.DB.prepare("UPDATE users SET sub_state = ? WHERE id = ? AND sub_state IS NOT ? RETURNING *")
      .bind(state, from.id, state)
      .first<User>();
    if (!u) return;
    const key = state === "failed" ? "bill_renew_failed" : state === "canceled" ? "bill_renew_canceled" : "bill_renew_resumed";
    const buttons = state === "failed" ? kb([[subscribeButton(ctx.lang)]]) : undefined;
    await ctx.api.sendMessage(u.id, t(ctx.lang, key, { date: date(u.paid_until ?? 0, ctx.lang) }), { ...html, reply_markup: buttons });
  });
}
