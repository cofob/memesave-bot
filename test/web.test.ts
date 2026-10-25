import { env } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleLogin, verifyIdToken } from "../src/login";
import { createSession } from "../src/session";
import { handleApp } from "../src/webapp";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const jobs: unknown[] = [];
const JOBS = { send: async (b: unknown) => void jobs.push(b) } as unknown as Queue;
const e = { ...env, PUBLIC_URL: "https://m.example", JOBS } as Env;
const botId = e.BOT_TOKEN.split(":")[0];
const b64 = (v: object | ArrayBuffer) => Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : JSON.stringify(v)).toString("base64url");

let keys: CryptoKeyPair;
let jwk: JsonWebKey;
beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" } as JsonWebKey;
});

async function idToken(claims: object) {
  const head = b64({ alg: "RS256", kid: "k1" });
  const body = b64(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}
const claims = (extra: object = {}) => ({ iss: "https://oauth.telegram.org", aud: botId, sub: "s", exp: Date.now() / 1000 + 60, id: 61, ...extra });
const jwksResponse = () => Response.json({ keys: [jwk] });

afterEach(() => vi.restoreAllMocks());

describe("Telegram Login (OIDC)", () => {
  it("verifies id_token signature, issuer, audience and expiry", async () => {
    expect(await verifyIdToken(await idToken(claims()), botId, async () => jwksResponse())).toMatchObject({ id: 61 });
    expect(await verifyIdToken(await idToken(claims({ aud: "999" })), botId)).toBeNull();
    expect(await verifyIdToken(await idToken(claims({ exp: 1 })), botId)).toBeNull();
    const forged = (await idToken(claims())).replace(/\.[^.]+\./, `.${b64(claims({ id: 1 }))}.`);
    expect(await verifyIdToken(forged, botId)).toBeNull();
  });

  it("redirects to Telegram with PKCE and logs in an allowed user on callback", async () => {
    const start = (await handleLogin(new Request("https://m.example/auth/telegram"), e))!;
    const location = new URL(start.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://oauth.telegram.org/auth");
    expect(location.searchParams.get("client_id")).toBe(botId);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const loginCookie = start.headers.get("Set-Cookie")!.split(";")[0];

    await e.DB.prepare("INSERT INTO users (id, role) VALUES (61, 'user')").run();
    let tokenRequest: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/token")) {
        tokenRequest = init;
        return Response.json({ id_token: await idToken(claims()) });
      }
      return jwksResponse();
    });
    const state = location.searchParams.get("state");
    const callback = (await handleLogin(
      new Request(`https://m.example/auth/telegram/callback?code=c1&state=${state}`, { headers: { Cookie: loginCookie } }),
      e,
    ))!;
    expect(callback.headers.get("Location")).toBe("/");
    expect(callback.headers.get("Set-Cookie")).toMatch(/session=61\.\d+\.[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax/);
    expect((tokenRequest!.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa(`${botId}:cs`)}`);
    expect(String(tokenRequest!.body)).toContain("code_verifier=");

    const bad = (await handleLogin(new Request(`https://m.example/auth/telegram/callback?code=c1&state=other`, { headers: { Cookie: loginCookie } }), e))!;
    expect(bad.headers.get("Location")).toBe("/?error=login_failed");
  });
});

describe("web upload", () => {
  it("stores uploads in R2 by sha256, dedupes and reports status", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (62, 'user')").run();
    const cookie = `session=${await createSession(e, 62)}`;
    const send = async () => {
      const form = new FormData();
      form.append("file", new File(["PNGDATA"], "a.png", { type: "image/png" }));
      form.append("width", "10");
      return (await handleApp(new Request("https://m.example/app/api/upload", { method: "POST", body: form, headers: { Cookie: cookie } }), e, ctx))!;
    };
    expect((await handleApp(new Request("https://m.example/app/api/me"), e, ctx))!.status).toBe(403);

    const first = await (await send()).json<{ id: string; duplicate: boolean }>();
    expect(first.duplicate).toBe(false);
    const sha = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("PNGDATA"))).toString("hex");
    expect(await (await e.MEDIA.get(`u/62/${sha}`))!.text()).toBe("PNGDATA");
    expect(await e.DB.prepare("SELECT kind, file_unique_id, r2_file, width, sha256 FROM memes WHERE id = ?").bind(first.id).first()).toEqual({
      kind: "photo",
      file_unique_id: `r2:${sha}`,
      r2_file: `u/62/${sha}`,
      width: 10,
      sha256: sha,
    });
    expect(jobs).toContainEqual({ type: "embed", memeId: first.id });

    expect(await (await send()).json()).toEqual({ id: first.id, duplicate: true });
    const status = await handleApp(new Request(`https://m.example/app/api/status?ids=${first.id}`, { headers: { Cookie: cookie } }), e, ctx);
    expect(await status!.json()).toEqual([{ id: first.id, status: "embedding", title: null }]);
  });
});
