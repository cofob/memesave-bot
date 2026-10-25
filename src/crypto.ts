import { applyPayment, langOfUser, paymentText, planUsd, type ProductKind } from "./billing";
import { botApi } from "./botapi";
import { CRYPTO_TOPUPS } from "./config";
import type { User } from "./db";
import type { Env } from "./env";

// Crypto payments via BTCPay Server: BTC, Lightning, XMR and USDT (USDt plugin). One-time, no auto-renewal.

export type Provider = "btcpay";

export interface CryptoInvoice {
  id: string;
  user_id: number;
  provider: Provider;
  kind: ProductKind;
  byok: number;
  usd: number;
  provider_ref: string | null;
  crypto: string | null;
  address: string | null;
  crypto_amount: string | null;
  status: "pending" | "partial" | "paid" | "expired" | "invalid";
  credited_usd: number;
  created_at: number;
  paid_at: number | null;
}

export const btcpayOn = (env: Env) => !!(env.BTCPAY_URL && env.BTCPAY_STORE_ID && env.BTCPAY_API_KEY);

/** USDT networks offered through BTCPay (empty when it is not configured). */
export const usdtNetworks = (env: Env) => (btcpayOn(env) ? (env.BTCPAY_USDT ?? "").split(",").map((c) => c.trim()).filter(Boolean) : []);

/** USD price of a product; a crypto top-up must be one of CRYPTO_TOPUPS. */
export function productUsd(kind: ProductKind, byok: boolean, topupUsd?: number): number | null {
  if (kind === "topup") return topupUsd && CRYPTO_TOPUPS.includes(topupUsd) ? topupUsd : null;
  return planUsd(kind, byok);
}

const base = (url: string) => url.replace(/\/$/, "");

async function insertInvoice(db: D1Database, inv: Partial<CryptoInvoice> & Pick<CryptoInvoice, "id" | "user_id" | "provider" | "kind" | "usd">) {
  await db
    .prepare(
      "INSERT INTO crypto_invoices (id, user_id, provider, kind, byok, usd, provider_ref, crypto, address, crypto_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(inv.id, inv.user_id, inv.provider, inv.kind, inv.byok ?? 0, inv.usd, inv.provider_ref ?? null, inv.crypto ?? null, inv.address ?? null, inv.crypto_amount ?? null)
    .run();
}

const btcpayApi = (env: Env, path: string, init: RequestInit = {}) =>
  fetch(`${base(env.BTCPAY_URL!)}/api/v1/stores/${env.BTCPAY_STORE_ID}/invoices${path}`, {
    ...init,
    headers: { Authorization: `token ${env.BTCPAY_API_KEY}`, "Content-Type": "application/json" },
  });

/** BTCPay invoice: the user pays on BTCPay's checkout page; with a network, only in USDT on that network. */
export async function createBtcpayInvoice(env: Env, u: User, kind: ProductKind, usdAmount: number, network?: string) {
  if (network && !usdtNetworks(env).includes(network)) throw new Error("unknown network");
  const id = crypto.randomUUID();
  const byok = u.openrouter_key !== null ? 1 : 0;
  const res = await btcpayApi(env, "", {
    method: "POST",
    body: JSON.stringify({
      amount: String(usdAmount),
      currency: "USD",
      metadata: { orderId: id, userId: u.id, kind, byok },
      checkout: {
        expirationMinutes: 60,
        redirectURL: `${base(env.PUBLIC_URL)}/`,
        ...(network ? { paymentMethods: [`USDT-${network.toUpperCase()}`] } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`btcpay ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const inv = await res.json<{ id: string; checkoutLink: string }>();
  await insertInvoice(env.DB, { id, user_id: u.id, provider: "btcpay", kind, byok, usd: usdAmount, provider_ref: inv.id, crypto: network });
  return { id, url: inv.checkoutLink };
}

export const getInvoice = (db: D1Database, id: string) => db.prepare("SELECT * FROM crypto_invoices WHERE id = ?").bind(id).first<CryptoInvoice>();

/** Applies a paid invoice once; an overpayment goes to the balance. Tells the user. */
export async function settleInvoice(env: Env, inv: CryptoInvoice, overUsd = 0) {
  const base = { userId: inv.user_id, method: inv.provider, byok: !!inv.byok };
  const { applied, user } = await applyPayment(env.DB, { ...base, kind: inv.kind, usd: inv.usd, chargeId: `${inv.provider}:${inv.id}` });
  if (!applied) return false;
  let u = user;
  if (overUsd > 0) u = (await applyPayment(env.DB, { ...base, kind: "topup", usd: overUsd, chargeId: `${inv.provider}:${inv.id}:over` })).user ?? u;
  await env.DB.prepare("UPDATE crypto_invoices SET status = 'paid', credited_usd = ?, paid_at = unixepoch() WHERE id = ?")
    .bind(inv.usd + overUsd, inv.id)
    .run();
  if (u) await botApi(env.BOT_TOKEN).sendMessage(u.id, paymentText(langOfUser(u), inv.kind, u, inv.usd), { parse_mode: "HTML" }).catch(console.error);
  return true;
}

const setStatus = (db: D1Database, id: string, status: CryptoInvoice["status"]) =>
  db.prepare("UPDATE crypto_invoices SET status = ? WHERE id = ? AND status IN ('pending', 'partial')").bind(status, id).run();

async function hmacHex(key: string, data: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string) {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/** BTCPay webhook: verified by BTCPay-Sig; the invoice status is re-read from BTCPay before it is applied. */
export async function handleBtcpay(req: Request, env: Env): Promise<Response> {
  if (!btcpayOn(env) || !env.BTCPAY_WEBHOOK_SECRET) return new Response("Not found", { status: 404 });
  const body = await req.text();
  const sig = req.headers.get("BTCPay-Sig") ?? "";
  if (!sameText(sig, `sha256=${await hmacHex(env.BTCPAY_WEBHOOK_SECRET, body)}`)) return new Response("Bad signature", { status: 401 });
  const event = JSON.parse(body) as { type?: string; invoiceId?: string };
  if (!event.invoiceId) return new Response("OK");
  const inv = await env.DB.prepare("SELECT * FROM crypto_invoices WHERE provider = 'btcpay' AND provider_ref = ?").bind(event.invoiceId).first<CryptoInvoice>();
  if (!inv) return new Response("OK");
  if (event.type === "InvoiceExpired") await setStatus(env.DB, inv.id, "expired");
  else if (event.type === "InvoiceInvalid") await setStatus(env.DB, inv.id, "invalid");
  else if (event.type === "InvoiceSettled") {
    const res = await btcpayApi(env, `/${encodeURIComponent(event.invoiceId)}`);
    const live = res.ok ? await res.json<{ status: string }>() : null;
    if (live?.status === "Settled") await settleInvoice(env, inv);
  }
  return new Response("OK");
}
