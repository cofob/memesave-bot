import { adminGrant, adminRevoke, listUsers } from "./admin";
import { batchProgress, cancelImport, finishImportFromApp, retryFailed, startImport } from "./batch";
import { t } from "./i18n";
import { botApi } from "./botapi";
import type { User } from "./db";
import type { Env } from "./env";
import { allStats, userStats } from "./stats";
import { oauthUrl, setUserKey } from "./userkey";
import { createZipImport, zipStatus } from "./zip";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** App equivalents of the bot commands: /stats, /settings, /key, /batch*, /batch_zip, /grant, /revoke, /users. */
export async function handleAccount(req: Request, env: Env, user: User, parts: string[]): Promise<Response | null> {
  const [resource, id = ""] = parts;
  const m = req.method;
  const lang = user.lang === "ru" ? "ru" : "en";

  if (resource === "stats" && m === "GET") {
    const all = new URL(req.url).searchParams.has("all");
    if (all && user.role !== "admin") return json({ error: "admins only" }, 403);
    return json(all ? await allStats(env) : await userStats(env, user));
  }

  if (resource === "settings" && m === "PUT") {
    const { search_mode } = await req.json<{ search_mode?: string }>();
    if (search_mode !== "advanced" && search_mode !== "fast") return json({ error: "bad search_mode" }, 400);
    await env.DB.prepare("UPDATE users SET search_mode = ? WHERE id = ?").bind(search_mode, user.id).run();
    return json({ ok: true });
  }

  if (resource === "key") {
    if (m === "POST") return json({ url: await oauthUrl(env, user.id, "web") });
    if (m === "DELETE") {
      await setUserKey(env, user.id, null);
      return json({ ok: true });
    }
  }

  if (resource === "batch") {
    if (m === "GET") return json(await batchProgress(env, user.id));
    if (m === "POST" && id === "retry") {
      // The bot posts the status message in the chat, as for /batch_retry.
      const msg = await botApi(env.BOT_TOKEN).sendMessage(user.id, t(lang, "batch_retry_started", { photos: "…", others: "…" }), { parse_mode: "HTML" });
      return json(await retryFailed(env, user.id, msg.message_id));
    }
    if (m === "POST" && id === "start") return json(await startImport(env.DB, user.id));
    if (m === "POST" && id === "finish") return json({ ok: await finishImportFromApp(env, user.id) });
    if (m === "POST" && id === "cancel") return json({ count: await cancelImport(env, user.id) });
  }

  if (resource === "zip") {
    if (m === "POST" && !id) {
      const zip = await createZipImport(env, user.id, lang);
      return json({ id: zip.id, url: zip.url });
    }
    if (m === "GET" && id) return json((await zipStatus(env.DB, id, user.id)) ?? { error: "not found" }, 200);
  }

  if (resource === "admin") {
    if (user.role !== "admin") return json({ error: "admins only" }, 403);
    if (m === "GET" && id === "users") return json(await listUsers(env));
    const body = m === "POST" ? await req.json<{ target?: string; role?: string }>() : {};
    const api = botApi(env.BOT_TOKEN);
    if (m === "POST" && id === "grant") return json(await adminGrant(env, api, user, body.target ?? "", body.role));
    if (m === "POST" && id === "revoke") return json(await adminRevoke(env, api, user, body.target ?? ""));
  }
  return null;
}
