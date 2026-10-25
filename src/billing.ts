import type { Api } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { botApi } from "./botapi";
import { CRYPTO_TOPUPS, LOW_BALANCE, MONTHLY_ALLOWANCE, PLANS, STAR_TOPUPS, STAR_USD } from "./config";
import type { User } from "./db";
import type { Env } from "./env";
import { t, type Key, type Lang } from "./i18n";

// Billing for the "paid" role: subscription (Stars or crypto), monthly included AI spend, USD balance.

const DAY = 86400;
const MONTH = 30 * DAY;
const now = () => Math.floor(Date.now() / 1000);

export type PlanKind = keyof typeof PLANS;
export type ProductKind = PlanKind | "topup";
export type Method = "stars" | "btcpay";

export const isFree = (u: Pick<User, "role">) => u.role !== "paid";
export const ownKey = (u: Pick<User, "openrouter_key">) => u.openrouter_key !== null;
export const isActive = (u: Pick<User, "paid_until">, at = now()) => (u.paid_until ?? 0) > at;
/** Whether the current plan time was bought at the full price, with included AI spend. */
export const hasAllowance = (u: Pick<User, "allowance_until">, at = now()) => (u.allowance_until ?? 0) > at;

/** Stars for a USD price: at STAR_USD, rounded up to 10⭐ ($1 = 80⭐, $0.5 = 40⭐, $10 = 770⭐, $4 = 310⭐). */
export const starsFor = (usdPrice: number) => Math.ceil(usdPrice / STAR_USD / 10) * 10;

/** Plan price in USD: the own-key price when the user has their own OpenRouter key. */
export const planUsd = (kind: PlanKind, byok: boolean) => (byok ? PLANS[kind].byokUsd : PLANS[kind].usd);

/** Start of the current 30-day allowance month. */
export const monthStart = (u: Pick<User, "plan_started">, at = now()) => {
  const start = u.plan_started ?? at;
  return start + Math.floor(Math.max(0, at - start) / MONTH) * MONTH;
};

/** Included AI spend left this month (0 for own-key plans and inactive subscriptions). */
export async function allowanceLeft(db: D1Database, u: User, at = now()) {
  if (isFree(u) || !hasAllowance(u, at)) return 0;
  const used =
    (await db
      .prepare("SELECT COALESCE(SUM(from_allowance), 0) AS s FROM transactions WHERE user_id = ? AND created_at >= ?")
      .bind(u.id, monthStart(u, at))
      .first<number>("s")) ?? 0;
  return Math.max(0, MONTHLY_ALLOWANCE - used);
}

export async function billingStatus(env: Env, u: User) {
  return {
    free: isFree(u),
    active: isFree(u) || isActive(u),
    plan: u.plan,
    byok: isActive(u) && !hasAllowance(u),
    ownKey: ownKey(u),
    paidUntil: u.paid_until,
    subState: u.sub_state,
    balance: u.balance,
    allowance: MONTHLY_ALLOWANCE,
    allowanceLeft: await allowanceLeft(env.DB, u),
    prices: {
      monthly: { usd: planUsd("monthly", ownKey(u)), stars: starsFor(planUsd("monthly", ownKey(u))) },
      yearly: { usd: planUsd("yearly", ownKey(u)), stars: starsFor(planUsd("yearly", ownKey(u))) },
    },
    starTopups: STAR_TOPUPS.map((stars) => ({ stars, usd: stars * STAR_USD })),
    cryptoTopups: CRYPTO_TOPUPS,
  };
}

export type Gate = { ok: true } | { ok: false; reason: "subscribe" | "credit" };

/** Whether new AI work may start: free roles always; paid users need an active plan and some way to pay. */
export async function canUseAi(db: D1Database, u: User): Promise<Gate> {
  if (isFree(u)) return { ok: true };
  if (!isActive(u)) return { ok: false, reason: "subscribe" };
  if (ownKey(u) || u.balance > 0 || (await allowanceLeft(db, u)) > 0) return { ok: true };
  return { ok: false, reason: "credit" };
}

/**
 * How a shared-key AI cost of a paid user is covered: included spend first, then the balance.
 * Returns the parts and the balance-deduction statement for the caller's batch.
 */
export async function splitCost(db: D1Database, u: User, cost: number) {
  const fromAllowance = Math.min(cost, await allowanceLeft(db, u));
  const fromBalance = cost - fromAllowance;
  return { fromAllowance, fromBalance };
}

export interface PaymentInput {
  userId: number;
  method: Method;
  kind: ProductKind;
  byok: boolean;
  usd: number;
  stars?: number;
  chargeId: string;
  recurring?: boolean;
  subChargeId?: string; // Stars subscription to cancel or resume later
}

/** Applies a payment once (by charge id): extends the plan or credits the balance. */
export async function applyPayment(db: D1Database, p: PaymentInput): Promise<{ applied: boolean; user: User | null }> {
  const inserted = await db
    .prepare(
      `INSERT INTO payments (user_id, method, kind, byok, stars, usd, charge_id, recurring) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(charge_id) DO NOTHING RETURNING id`,
    )
    .bind(p.userId, p.method, p.kind, p.byok ? 1 : 0, p.stars ?? null, p.usd, p.chargeId, p.recurring ? 1 : 0)
    .first();
  if (!inserted) return { applied: false, user: null };

  const at = now();
  const user =
    p.kind === "topup"
      ? await db.prepare("UPDATE users SET balance = balance + ? WHERE id = ? RETURNING *").bind(p.usd, p.userId).first<User>()
      : await db
          .prepare(
            // SET expressions read the old row: a lapsed plan restarts its allowance months now.
            `UPDATE users SET
               plan = ?, plan_byok = ?,
               plan_started = CASE WHEN COALESCE(paid_until, 0) <= ? THEN ? ELSE plan_started END,
               paid_until = MAX(COALESCE(paid_until, 0), ?) + ?,
               allowance_until = CASE WHEN ? THEN allowance_until ELSE MAX(COALESCE(allowance_until, 0), ?) + ? END,
               sub_charge_id = COALESCE(?, sub_charge_id),
               sub_state = CASE WHEN ? IS NOT NULL THEN 'active' ELSE sub_state END
             WHERE id = ? RETURNING *`,
          )
          .bind(p.kind, p.byok ? 1 : 0, at, at, at, PLANS[p.kind].days * DAY, p.byok ? 1 : 0, at, PLANS[p.kind].days * DAY, p.subChargeId ?? null, p.subChargeId ?? null, p.userId)
          .first<User>();
  return { applied: true, user };
}

/** Sends a billing notice once per (user, key). */
export async function notifyOnce(env: Env, userId: number, key: string, text: string, buttons: InlineKeyboardButton[][] = []) {
  const fresh = await env.DB.prepare("INSERT INTO notices (user_id, key) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING key")
    .bind(userId, key)
    .first();
  if (!fresh) return false;
  await botApi(env.BOT_TOKEN)
    .sendMessage(userId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } })
    .catch(console.error);
  return true;
}

/** Prices and balances: whole cents. */
export const money = (x: number) => `$${x.toFixed(2)}`;
export const langOfUser = (u: Pick<User, "lang">): Lang => (u.lang === "ru" ? "ru" : "en");
export const date = (ts: number, lang: Lang) => new Date(ts * 1000).toLocaleDateString(lang === "ru" ? "ru-RU" : "en-GB");

export const subscribeButton = (lang: Lang): InlineKeyboardButton => ({ text: t(lang, "bill_btn_subscribe"), callback_data: "bill:subscribe" });
export const topupButton = (lang: Lang): InlineKeyboardButton => ({ text: t(lang, "bill_btn_topup"), callback_data: "bill:topup" });

/** Notices after a spend: 80% / all of the month's included spend, low / empty balance. */
export async function spendNotices(env: Env, before: User, fromAllowance: number, fromBalance: number) {
  const lang = langOfUser(before);
  if (fromAllowance > 0) {
    const left = await allowanceLeft(env.DB, before);
    const start = monthStart(before);
    if (left <= 0) {
      await notifyOnce(env, before.id, `allow100:${start}`, t(lang, "bill_allow_done", { balance: money(before.balance) }), [[topupButton(lang)]]);
    } else if (left <= MONTHLY_ALLOWANCE * 0.2) {
      await notifyOnce(env, before.id, `allow80:${start}`, t(lang, "bill_allow_80", { left: money(left) }), [[topupButton(lang)]]);
    }
  }
  if (fromBalance > 0) {
    const balance = before.balance - fromBalance;
    // Keyed by the last top-up, so the next top-up can warn again.
    const lastTopup =
      (await env.DB.prepare("SELECT MAX(id) AS id FROM payments WHERE user_id = ? AND kind = 'topup'").bind(before.id).first<number>("id")) ?? 0;
    if (balance <= 0) await notifyOnce(env, before.id, `empty:${lastTopup}`, t(lang, "bill_balance_empty"), [[topupButton(lang)]]);
    else if (balance < LOW_BALANCE) {
      await notifyOnce(env, before.id, `low:${lastTopup}`, t(lang, "bill_balance_low", { balance: money(balance) }), [[topupButton(lang)]]);
    }
  }
}

/** Cron: upcoming renewals and expiries, and ended subscriptions (each notice once per period). */
export async function billingNotices(env: Env, at = now()) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM users WHERE role = 'paid' AND paid_until IS NOT NULL AND paid_until BETWEEN ? AND ?",
  )
    .bind(at - 2 * DAY, at + 7 * DAY)
    .all<User>();
  for (const u of results) {
    const lang = langOfUser(u);
    const until = u.paid_until!;
    const renews = u.plan === "monthly" && u.sub_state === "active" && !!u.sub_charge_id;
    const when = date(until, lang);
    if (until <= at) {
      await notifyOnce(env, u.id, `expired:${until}`, t(lang, "bill_expired"), [[subscribeButton(lang)]]);
    } else if (renews) {
      if (until - at <= 3 * DAY) {
        const stars = starsFor(planUsd("monthly", !!u.plan_byok));
        await notifyOnce(env, u.id, `renew3:${until}`, t(lang, "bill_renew_soon", { date: when, stars }));
      }
    } else if (until - at <= DAY) {
      await notifyOnce(env, u.id, `expiry1:${until}`, t(lang, "bill_expiry_soon", { date: when }), [[subscribeButton(lang)]]);
    } else {
      await notifyOnce(env, u.id, `expiry7:${until}`, t(lang, "bill_expiry_soon", { date: when }), [[subscribeButton(lang)]]);
    }
  }
}

/** Confirmation after a payment, in the user's language. */
export function paymentText(lang: Lang, kind: ProductKind, u: User, amountUsd: number, recurring = false): string {
  if (kind === "topup") return t(lang, "bill_topped_up", { amount: money(amountUsd), balance: money(u.balance) });
  return t(lang, recurring ? "bill_renewed" : "bill_active", { date: date(u.paid_until ?? now(), lang) });
}

/** Payload of a Stars invoice: checked again in pre_checkout_query and on payment. */
export interface StarsPayload {
  u: number;
  k: ProductKind;
  b: 0 | 1;
  s: number;
}

/** Expected price in Stars for a payload, or null when it is not a valid product. */
export function expectedStars(p: StarsPayload): number | null {
  if (p.k === "topup") return STAR_TOPUPS.includes(p.s) ? p.s : null;
  if (p.k !== "monthly" && p.k !== "yearly") return null;
  return starsFor(planUsd(p.k, !!p.b));
}

/** Invoice link for a Stars product; the monthly plan is a 30-day auto-renewing subscription. */
export async function starsInvoiceLink(api: Api, u: User, lang: Lang, kind: ProductKind, topupStars?: number) {
  const byok = ownKey(u) ? 1 : 0;
  const payload: StarsPayload = { u: u.id, k: kind, b: byok, s: 0 };
  payload.s = kind === "topup" ? (topupStars ?? 0) : starsFor(planUsd(kind, !!byok));
  if (expectedStars(payload) === null) throw new Error("invalid product");
  const title = t(lang, `bill_title_${kind}` as Key);
  const description =
    kind === "topup" ? t(lang, "bill_desc_topup", { amount: money(payload.s * STAR_USD) }) : t(lang, byok ? "bill_desc_byok" : "bill_desc_plan");
  return api.createInvoiceLink(title, description, JSON.stringify(payload), "", "XTR", [{ label: title, amount: payload.s }], {
    ...(kind === "monthly" ? { subscription_period: 30 * DAY } : {}),
  });
}

/** USD value of a Stars payment for the records and the balance. */
export const starsPaymentUsd = (p: StarsPayload) => (p.k === "topup" ? p.s * STAR_USD : planUsd(p.k, !!p.b));
