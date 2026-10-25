import { AuthorizationError, getOAuthApi, type ConsentDescription, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { MCP_SCOPES } from "./config";
import { getUser, type User } from "./db";
import type { Env } from "./env";
import { esc, t, type Key, type Lang } from "./i18n";
import { mcpApi, type McpProps } from "./mcp";
import { getCookie, readSession } from "./session";
import { CSS } from "./uploadpage";

// OAuth 2.1 for MCP clients (workers-oauth-provider): the user logs in with Telegram and approves here.

const DAY = 86400;
const SCOPES = [MCP_SCOPES.read, MCP_SCOPES.write];
const base = (env: Env) => env.PUBLIC_URL.replace(/\/$/, "");
const notFound = { fetch: () => new Response("Not found", { status: 404 }) };

export const oauthOptions = (env: Env, defaultHandler: ExportedHandler<Env> = notFound): OAuthProviderOptions<Env> => ({
  apiRoute: "/mcp",
  apiHandler: mcpApi,
  defaultHandler,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: SCOPES,
  requiredScopes: SCOPES, // clients ask for both; the user can turn off write access
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: `${base(env)}/mcp`, resource_name: "Memesave" },
  accessTokenTTL: 3600,
  refreshTokenTTL: 30 * DAY,
  refreshTokenIdleTTL: 30 * DAY, // a connection lives while it is used at least once a month
});

/** Grant and consent helpers outside the provider's request handling. */
export const oauthApi = (env: Env) => getOAuthApi(oauthOptions(env), env);

const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

function page(lang: Lang, body: string, status = 200, headers?: Headers) {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  const html = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(t(lang, "consent_title"))}</title>
  <link rel="stylesheet" href="${CSS}">
</head>
<body>
  <main class="cf-container cf-container--narrow cf-section">
    <div class="cf-stack">
      <h1 class="cf-heading cf-heading--2">${esc(t(lang, "consent_title"))}</h1>
      ${body}
    </div>
  </main>
</body>
</html>`;
  return new Response(html, { status, headers: h });
}

const errorPage = (lang: Lang) =>
  page(lang, `<div class="cf-alert" data-tone="danger"><div class="cf-alert__content"><p class="cf-alert__title">${esc(t(lang, "consent_error"))}</p></div></div>`, 400);

/** Consent form; every client string is escaped (it comes from client registration or its metadata document). */
function consentBody(lang: Lang, d: ConsentDescription, handle: string, user: User) {
  const s = (key: Key, params?: Record<string, string>) => esc(t(lang, key, params));
  const muted = (text: string) => `<p class="cf-text cf-text--muted">${text}</p>`;
  return `<form class="cf-card" method="post"><div class="cf-card__body cf-stack">
    <p class="cf-text">${s("consent_lead", { client: d.clientName })}</p>
    ${muted(d.clientDomain ? s("consent_domain", { domain: d.clientDomain }) : s("consent_unverified"))}
    ${muted(s("consent_redirect", { host: d.redirectHost }))}
    ${d.redirectIsLoopback ? `<div class="cf-alert" data-tone="warning"><div class="cf-alert__content"><p class="cf-alert__description">${s("consent_loopback")}</p></div></div>` : ""}
    <label class="cf-text"><input type="checkbox" checked disabled> ${s("consent_read")}</label>
    <label class="cf-text"><input type="checkbox" name="write" value="1"${d.scope.includes(MCP_SCOPES.write) ? " checked" : ""}> ${s("consent_write")}</label>
    ${muted(s("consent_as", { user: user.username ? `@${user.username}` : String(user.id) }))}
    <input type="hidden" name="handle" value="${attr(handle)}">
    <div class="cf-inline" data-gap="sm">
      <button class="cf-button" name="decision" value="allow">${s("consent_allow")}</button>
      <button class="cf-button" data-variant="secondary" name="decision" value="deny">${s("consent_deny")}</button>
    </div>
  </div></form>`;
}

/** GET/POST /oauth/authorize: login check, consent page, then the redirect with the code. */
export async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const api = oauthApi(env);
  const userId = await readSession(env, getCookie(req, "session"));
  const user = userId ? await getUser(env.DB, userId) : null;
  const lang: Lang = (user?.lang ?? req.headers.get("Accept-Language") ?? "").startsWith("ru") ? "ru" : "en";
  // A redirect is safe only after the library validated the client and its redirect URI.
  const failed = (e: unknown) => {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    console.warn("oauth authorize", e);
    return errorPage(lang);
  };

  if (req.method === "POST") {
    if (!user) return errorPage(lang);
    const form = await req.clone().formData();
    const handle = String(form.get("handle") ?? "");
    try {
      if (form.get("decision") !== "allow") return new Response(null, { status: 302, headers: (await api.denyConsent(req, handle)).headers });
      const scope = form.get("write") ? SCOPES : [MCP_SCOPES.read];
      const { request, headers } = await api.approveConsent(req, handle, { scope });
      const d = await api.describeConsent(request);
      const props: McpProps = { userId: user.id };
      const { redirectTo } = await api.completeAuthorization({
        request,
        userId: String(user.id),
        scope,
        metadata: { client: d.clientName, domain: d.clientDomain ?? null },
        props,
      });
      headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers });
    } catch (e) {
      return failed(e);
    }
  }

  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  try {
    const authReq = await api.parseAuthRequest(req);
    if (!user) {
      const url = new URL(req.url);
      return Response.redirect(`${base(env)}/auth/telegram?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    const tx = await api.beginConsent(authReq);
    return page(lang, consentBody(lang, await api.describeConsent(authReq), tx.handle, user), 200, tx.headers);
  } catch (e) {
    return failed(e);
  }
}
