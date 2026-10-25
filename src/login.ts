import { Buffer } from "node:buffer";
import { resolveUser } from "./auth";
import type { Env } from "./env";
import { cookie, createSession, getCookie, SESSION_TTL } from "./session";

// Telegram Login: OpenID Connect authorization code flow with PKCE (https://core.telegram.org/widgets/login).
const ISSUER = "https://oauth.telegram.org";
const enc = (s: string) => new TextEncoder().encode(s);
const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const botId = (env: Env) => env.BOT_TOKEN.split(":")[0];
const redirectUri = (env: Env) => `${env.PUBLIC_URL.replace(/\/$/, "")}/auth/telegram/callback`;

// After login the user returns only to the MCP consent page; anything else goes to "/" (no open redirect).
const nextPath = (next: string | null | undefined) => (next?.startsWith("/oauth/authorize?") ? next : "/");

function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

const ALGS: Record<string, [SubtleCryptoImportKeyAlgorithm, SubtleCryptoSignAlgorithm]> = {
  RS256: [{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, { name: "RSASSA-PKCS1-v1_5" }],
  ES256: [{ name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }],
  EdDSA: [{ name: "Ed25519" }, { name: "Ed25519" }],
};

let jwks: { keys: (JsonWebKey & { kid?: string })[] } | undefined;
let jwksAt = 0;

/** Verifies the id_token signature with Telegram's JWKS and checks iss, aud and exp. */
export async function verifyIdToken(token: string, audience: string, fetchJwks = () => fetch(`${ISSUER}/.well-known/jwks.json`)) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const alg = ALGS[header.alg];
  if (!alg) return null;
  if (!jwks || Date.now() - jwksAt > 3600_000) {
    jwks = await (await fetchJwks()).json();
    jwksAt = Date.now();
  }
  const jwk = jwks!.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, alg[0], false, ["verify"]);
  if (!(await crypto.subtle.verify(alg[1], key, Buffer.from(s, "base64url"), enc(`${h}.${p}`)))) return null;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)];
  if (claims.iss !== ISSUER || !aud.includes(audience) || claims.exp < Date.now() / 1000) return null;
  return claims as { id?: number | string; sub: string; name?: string; preferred_username?: string };
}

/** /auth/telegram, /auth/telegram/callback, /auth/logout */
export async function handleLogin(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname === "/auth/telegram") {
    const state = random(16);
    const verifier = random(32);
    const params = new URLSearchParams({
      client_id: botId(env),
      redirect_uri: redirectUri(env),
      response_type: "code",
      scope: "openid profile",
      state,
      code_challenge: b64url(await crypto.subtle.digest("SHA-256", enc(verifier))),
      code_challenge_method: "S256",
    });
    const next = b64url(enc(nextPath(url.searchParams.get("next"))));
    return redirect(`${ISSUER}/auth?${params}`, [cookie("tg_login", `${state}.${verifier}.${next}`, 600)]);
  }

  if (url.pathname === "/auth/telegram/callback") {
    const fail = (error: string) => redirect(`/?error=${error}`, [cookie("tg_login", "", 0)]);
    const [state, verifier, next] = (getCookie(req, "tg_login") ?? "").split(".");
    const code = url.searchParams.get("code");
    if (!state || !verifier || !code || state !== url.searchParams.get("state")) return fail("login_failed");

    const res = await fetch(`${ISSUER}/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${botId(env)}:${env.TG_CLIENT_SECRET}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(env), client_id: botId(env), code_verifier: verifier }),
    });
    const data = await res.json<{ id_token?: string }>().catch(() => ({}) as { id_token?: string });
    const claims = res.ok && data.id_token ? await verifyIdToken(data.id_token, botId(env)) : null;
    if (!claims?.id) return fail("login_failed");

    const lang = req.headers.get("Accept-Language")?.slice(0, 2);
    const access = await resolveUser(env, {
      id: Number(claims.id),
      is_bot: false,
      first_name: claims.name ?? "",
      username: claims.preferred_username,
      language_code: lang,
    });
    if (!access) return fail("no_access");
    return redirect(nextPath(Buffer.from(next ?? "", "base64url").toString()), [cookie("session", await createSession(env, access.user.id), SESSION_TTL), cookie("tg_login", "", 0)]);
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    return new Response(null, { status: 204, headers: { "Set-Cookie": cookie("session", "", 0) } });
  }
  return null;
}
