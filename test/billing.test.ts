import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowanceLeft, applyPayment, billingNotices, canUseAi, expectedStars, starsFor } from "../src/billing";
import { handleBtcpay, handleShkeeper } from "../src/crypto";
import { getUser, type User } from "../src/db";
import type { Env } from "../src/env";
import { recordSpend } from "../src/spend";

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const e = {
  ...env,
  PUBLIC_URL: "https://m.example",
  BTCPAY_URL: "https://pay.example",
  BTCPAY_STORE_ID: "st",
  BTCPAY_API_KEY: "bk",
  BTCPAY_WEBHOOK_SECRET: "whs",
  SHKEEPER_URL: "https://shk.example",
  SHKEEPER_CRYPTOS: "ETH-USDT,POLYGON-USDT",
  SHKEEPER_API_KEY: "sk",
} as Env;

let sent: string[] = [];
let btcpayStatus = "Settled";
beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.telegram.org")) {
      sent.push(String(JSON.parse(String(init?.body ?? "{}")).text ?? ""));
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (url.startsWith("https://pay.example/")) return Response.json({ id: "inv1", status: btcpayStatus });
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => vi.restoreAllMocks());

const user = async (id: number, fields = "") => {
  await e.DB.prepare(`INSERT INTO users (id, role, lang) VALUES (?, 'paid', 'en')`).bind(id).run();
  if (fields) await e.DB.prepare(`UPDATE users SET ${fields} WHERE id = ?`).bind(id).run();
  return (await getUser(e.DB, id))!;
};

const hex = async (key: string, data: string) => {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
};

describe("prices", () => {
  it("converts USD to Stars rounded up to 10", () => {
    expect([1, 0.5, 10, 4].map(starsFor)).toEqual([80, 40, 770, 310]);
    expect(expectedStars({ u: 1, k: "monthly", b: 0, s: 80 })).toBe(80);
    expect(expectedStars({ u: 1, k: "yearly", b: 1, s: 310 })).toBe(310);
    expect(expectedStars({ u: 1, k: "topup", b: 0, s: 100 })).toBe(100);
    expect(expectedStars({ u: 1, k: "topup", b: 0, s: 7 })).toBeNull();
  });
});

describe("payments", () => {
  it("extends plans, credits top-ups, ignores duplicates", async () => {
    await user(101);
    const pay = (kind: "monthly" | "yearly" | "topup", chargeId: string, usd = 1) =>
      applyPayment(e.DB, { userId: 101, method: "stars", kind, byok: false, usd, chargeId, subChargeId: kind === "monthly" ? "sub1" : undefined });
    const t0 = now();
    const first = await pay("monthly", "c1");
    expect(first.applied).toBe(true);
    expect(first.user!.paid_until).toBeGreaterThanOrEqual(t0 + 30 * DAY);
    expect(first.user).toMatchObject({ plan: "monthly", sub_charge_id: "sub1", sub_state: "active" });
    expect((await pay("monthly", "c1")).applied).toBe(false);
    const renewed = await pay("monthly", "c2");
    expect(renewed.user!.paid_until).toBe(first.user!.paid_until! + 30 * DAY);
    expect(renewed.user!.plan_started).toBe(first.user!.plan_started);
    const yearly = await pay("yearly", "c3", 10);
    expect(yearly.user!.paid_until).toBe(renewed.user!.paid_until! + 360 * DAY);
    const topup = await pay("topup", "c4", 1.3);
    expect(topup.user!.balance).toBeCloseTo(1.3);
  });
});

describe("included spend and gate", () => {
  it("free roles pass; paid users need a plan, then allowance, balance or own key", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (200, 'user')").run();
    expect(await canUseAi(e.DB, (await getUser(e.DB, 200))!)).toEqual({ ok: true });
    expect(await canUseAi(e.DB, await user(201))).toEqual({ ok: false, reason: "subscribe" });
    const active = `paid_until = ${now() + 10 * DAY}, plan_started = ${now() - 5 * DAY}, plan = 'monthly'`;
    expect(await canUseAi(e.DB, await user(202, active))).toEqual({ ok: true });
    expect(await canUseAi(e.DB, await user(203, `${active}, plan_byok = 1`))).toEqual({ ok: false, reason: "credit" });
    expect(await canUseAi(e.DB, await user(204, `${active}, plan_byok = 1, balance = 0.2`))).toEqual({ ok: true });
    expect(await canUseAi(e.DB, await user(205, `${active}, plan_byok = 1, openrouter_key = 'x'`))).toEqual({ ok: true });
  });

  it("takes shared-key costs from the allowance, then the balance; own-key costs are free", async () => {
    const u = await user(210, `paid_until = ${now() + 10 * DAY}, plan_started = ${now() - 31 * DAY}, plan = 'monthly', balance = 1`);
    // Spend in the previous allowance month does not count.
    await e.DB.prepare("INSERT INTO transactions (user_id, kind, model, key_source, cost, from_allowance, created_at) VALUES (210, 'x', 'm', 'global', 0.5, 0.5, ?)")
      .bind(now() - 2 * DAY)
      .run();
    expect(await allowanceLeft(e.DB, u)).toBe(0.5);
    await recordSpend(e, { userId: 210, kind: "describe" }, "m", "global", { cost: 0.45 });
    await recordSpend(e, { userId: 210, kind: "describe" }, "m", "global", { cost: 0.1 });
    await recordSpend(e, { userId: 210, kind: "describe" }, "m", "user", { cost: 5 });
    const after = (await getUser(e.DB, 210))!;
    expect(after.balance).toBeCloseTo(0.95);
    expect(await allowanceLeft(e.DB, after)).toBeCloseTo(0);
    const rows = await e.DB.prepare("SELECT from_allowance a, from_balance b FROM transactions WHERE user_id = 210 AND created_at > ? ORDER BY id")
      .bind(now() - DAY)
      .all<{ a: number; b: number }>();
    expect(rows.results.map((r) => [+r.a.toFixed(2), +r.b.toFixed(2)])).toEqual([[0.45, 0], [0.05, 0.05], [0, 0]]);
    expect(sent.some((t) => t.includes("80%"))).toBe(true);
    expect(sent.some((t) => t.includes("used up"))).toBe(true);
  });
});

describe("billing notices", () => {
  it("sends each notice once per period", async () => {
    const at = now();
    await user(301, `plan = 'monthly', sub_state = 'active', sub_charge_id = 's', paid_until = ${at + 2 * DAY}`);
    await user(302, `plan = 'yearly', paid_until = ${at + 5 * DAY}`);
    await user(303, `plan = 'yearly', paid_until = ${at + DAY / 2}`);
    await user(304, `plan = 'monthly', paid_until = ${at - DAY}`);
    await billingNotices(e, at);
    await billingNotices(e, at + 60);
    const keys = await e.DB.prepare("SELECT user_id, key FROM notices WHERE user_id BETWEEN 301 AND 304 ORDER BY user_id").all<{ user_id: number; key: string }>();
    expect(keys.results.map((r) => `${r.user_id}:${r.key.split(":")[0]}`)).toEqual(["301:renew3", "302:expiry7", "303:expiry1", "304:expired"]);
    expect(sent).toHaveLength(4);
  });
});

describe("BTCPay", () => {
  const hook = async (body: object, secret = "whs") => {
    const raw = JSON.stringify(body);
    return handleBtcpay(new Request("https://m.example/pay/btcpay", { method: "POST", body: raw, headers: { "BTCPay-Sig": `sha256=${await hex(secret, raw)}` } }), e);
  };

  it("checks the signature and applies a settled invoice once", async () => {
    await user(401);
    await e.DB.prepare("INSERT INTO crypto_invoices (id, user_id, provider, kind, usd, provider_ref) VALUES ('o1', 401, 'btcpay', 'monthly', 1, 'inv1')").run();
    expect((await hook({ type: "InvoiceSettled", invoiceId: "inv1" }, "bad")).status).toBe(401);
    btcpayStatus = "Processing";
    await hook({ type: "InvoiceSettled", invoiceId: "inv1" });
    expect((await getUser(e.DB, 401))!.paid_until).toBeNull();
    btcpayStatus = "Settled";
    await hook({ type: "InvoiceSettled", invoiceId: "inv1" });
    await hook({ type: "InvoiceSettled", invoiceId: "inv1" });
    expect((await getUser(e.DB, 401))!.paid_until).toBeGreaterThan(now() + 29 * DAY);
    expect(await e.DB.prepare("SELECT COUNT(*) n FROM payments WHERE user_id = 401").first("n")).toBe(1);
    expect(await e.DB.prepare("SELECT status FROM crypto_invoices WHERE id = 'o1'").first("status")).toBe("paid");
  });
});

describe("SHKeeper", () => {
  const callback = async (body: object, opts: { ts?: number; key?: string } = {}) => {
    const raw = JSON.stringify(body);
    const ts = String(opts.ts ?? now());
    const sig = await hex(opts.key ?? "sk", `${ts}.${raw}`);
    return handleShkeeper(
      new Request("https://m.example/pay/shkeeper", { method: "POST", body: raw, headers: { "X-Shkeeper-Timestamp": ts, "X-Shkeeper-Signature": sig } }),
      e,
    );
  };

  it("verifies callbacks; PARTIAL waits, PAID applies once, OVERPAID credits the balance", async () => {
    await user(501);
    await e.DB.prepare("INSERT INTO crypto_invoices (id, user_id, provider, kind, usd) VALUES ('s1', 501, 'shkeeper', 'yearly', 10), ('s2', 501, 'shkeeper', 'topup', 5)").run();
    expect((await callback({ external_id: "s1", status: "PAID" }, { key: "bad" })).status).toBe(401);
    expect((await callback({ external_id: "s1", status: "PAID" }, { ts: now() - 600 })).status).toBe(401);
    expect((await callback({ external_id: "s1", status: "PARTIAL", balance_fiat: "4" })).status).toBe(202);
    expect((await getUser(e.DB, 501))!.paid_until).toBeNull();
    await callback({ external_id: "s1", status: "PAID" });
    await callback({ external_id: "s1", status: "PAID" });
    expect((await getUser(e.DB, 501))!.paid_until).toBeGreaterThan(now() + 359 * DAY);
    await callback({ external_id: "s2", status: "OVERPAID", overpaid_fiat: "0.5" });
    expect((await getUser(e.DB, 501))!.balance).toBeCloseTo(5.5);
    expect(await e.DB.prepare("SELECT COUNT(*) n FROM payments WHERE user_id = 501").first("n")).toBe(3);
  });
});

describe("web gate", () => {
  it("answers 402 for AI work without a plan", async () => {
    const { handleApp } = await import("../src/webapp");
    const { createSession } = await import("../src/session");
    const u: User = await user(601);
    const cookie = `session=${await createSession(e, u.id)}`;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const get = (path: string) => handleApp(new Request(`https://m.example${path}`, { headers: { Cookie: cookie } }), e, ctx);
    const res = (await get("/app/api/search?q=cats&mode=fast"))!;
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ reason: "subscribe" });
    expect((await get("/app/api/memes"))!.status).toBe(200);
    expect(await (await get("/app/api/me"))!.json()).toMatchObject({ role: "paid", billing: { active: false, prices: { monthly: { stars: 80 } } } });
  });
});
