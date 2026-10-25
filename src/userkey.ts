import { botApi } from "./botapi";
import { Buffer } from "node:buffer";
import type { Env } from "./env";
import { userLang } from "./db";
import { t } from "./i18n";

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const aesKey = async (secret: string) =>
  crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);

/** AES-GCM; output is "iv.ciphertext" in base64url. */
export async function encrypt(secret: string, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), new TextEncoder().encode(plain));
  return `${b64url(iv)}.${b64url(data)}`;
}

export async function decrypt(secret: string, sealed: string) {
  const [iv, data] = sealed.split(".").map((s) => Buffer.from(s, "base64url"));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(secret), data));
}

const cache = new Map<number, { key: string | null; at: number }>();

/** The user's own OpenRouter key if connected, else the bot's global key. Cached for 60 s per isolate. */
export async function apiKey(env: Env, userId: number): Promise<{ key: string; source: "global" | "user" }> {
  let hit = cache.get(userId);
  if (!hit || Date.now() - hit.at > 60_000) {
    const sealed = await env.DB.prepare("SELECT openrouter_key FROM users WHERE id = ?").bind(userId).first<string | null>("openrouter_key");
    hit = { key: sealed ? await decrypt(env.ENCRYPTION_KEY, sealed) : null, at: Date.now() };
    cache.set(userId, hit);
  }
  return hit.key ? { key: hit.key, source: "user" } : { key: env.OPENROUTER_API_KEY, source: "global" };
}

/** Key for a given source; "user" falls back to the global key when the user removed theirs. */
export const keyFor = async (env: Env, userId: number, source: "global" | "user") =>
  source === "global" ? env.OPENROUTER_API_KEY : (await apiKey(env, userId)).key;

export async function setUserKey(env: Env, userId: number, key: string | null) {
  const sealed = key ? await encrypt(env.ENCRYPTION_KEY, key) : null;
  await env.DB.prepare("UPDATE users SET openrouter_key = ? WHERE id = ?").bind(sealed, userId).run();
  cache.delete(userId);
}

/** Starts OpenRouter OAuth PKCE and returns the URL the user must open. */
/** `returnTo` "web": OpenRouter redirects back to the web app instead of the bot chat. */
export async function oauthUrl(env: Env, userId: number, returnTo: "telegram" | "web" = "telegram") {
  const state = random(16), verifier = random(32);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE user_id = ? OR created_at < unixepoch() - 600").bind(userId),
    env.DB.prepare("INSERT INTO oauth_states (state, user_id, verifier, return_to) VALUES (?, ?, ?, ?)").bind(state, userId, verifier, returnTo),
  ]);
  const params = new URLSearchParams({
    callback_url: `${env.PUBLIC_URL.replace(/\/$/, "")}/oauth/callback`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    key_label: "memesave-bot",
  });
  return `https://openrouter.ai/auth?${params}`;
}

/** Redirects back to the bot chat; `start` makes Telegram send /start <start>. */
async function backToBot(env: Env, start?: string) {
  const { username } = await botApi(env.BOT_TOKEN).getMe();
  return Response.redirect(`https://t.me/${username}${start ? `?start=${start}` : ""}`, 302);
}

/** GET /oauth/callback: exchanges the code for a key and saves it for the user. */
export async function oauthCallback(req: Request, env: Env) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code || !state) return backToBot(env, "key_failed");
  const row = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state = ? AND created_at > unixepoch() - 600 RETURNING user_id, verifier, return_to",
  )
    .bind(state)
    .first<{ user_id: number; verifier: string; return_to: string | null }>();
  if (!row) return backToBot(env, "key_failed");
  const back = (ok: boolean) =>
    row.return_to === "web"
      ? Response.redirect(`${env.PUBLIC_URL.replace(/\/$/, "")}/?key=${ok ? "connected" : "failed"}`, 302)
      : backToBot(env, ok ? undefined : "key_failed");

  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: row.verifier, code_challenge_method: "S256" }),
  });
  const data = await res.json<{ key?: string }>().catch(() => ({}) as { key?: string });
  if (!res.ok || !data.key) return back(false);

  await setUserKey(env, row.user_id, data.key);
  const lang = await userLang(env.DB, row.user_id);
  await botApi(env.BOT_TOKEN).sendMessage(row.user_id, t(lang, "key_connected"), { parse_mode: "HTML" }).catch(console.error);
  return back(true);
}
