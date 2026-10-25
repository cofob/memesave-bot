import { adminGrant, adminRevoke, listUsers } from "./admin";
import { batchProgress, cancelImport, finishImportFromApp, retryFailed, startImport } from "./batch";
import { t } from "./i18n";
import { botApi } from "./botapi";
import type { User } from "./db";
import type { Env } from "./env";
import { allStats, userStats } from "./stats";
import { BACKFILL_WHERE, queueHashBackfill } from "./ingest/embed";
import { queueRekey, recoverLostKeys, REKEY_WHERE } from "./rekey";
import { oauthUrl, setUserKey } from "./userkey";
import { createZipImport, zipStatus } from "./zip";
import { exportStatus, setExportStatusMessage, startExport } from "./export";
import { accountSummary, CONFIRM, deleteAccount } from "./purge";
import { billingStatus, ownKey, starsInvoiceLink, type ProductKind } from "./billing";
import { addChannelUrl, listChannels, removeChannel, updateChannel } from "./channels";
import { btcpayOn, createBtcpayInvoice, getInvoice, productUsd, usdtNetworks } from "./crypto";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** App equivalents of the bot commands: /stats, /settings, /key, /batch*, /batch_zip, /export, /delete_all, /grant, /revoke, /users. */
export async function handleAccount(req: Request, env: Env, user: User, parts: string[]): Promise<Response | null> {
  const [resource, id = "", action = ""] = parts;
  const m = req.method;
  const lang = user.lang === "ru" ? "ru" : "en";

  if (resource === "stats" && m === "GET") {
    const all = new URL(req.url).searchParams.has("all");
    if (all && user.role !== "admin") return json({ error: "admins only" }, 403);
    return json(all ? await allStats(env) : await userStats(env, user));
  }

  if (resource === "settings" && m === "PUT") {
    const { search_mode = user.search_mode, describe_tier = user.describe_tier } = await req.json<{ search_mode?: string; describe_tier?: string }>();
    if (search_mode !== "advanced" && search_mode !== "fast") return json({ error: "bad search_mode" }, 400);
    if (describe_tier !== "max" && describe_tier !== "medium") return json({ error: "bad describe_tier" }, 400);
    await env.DB.prepare("UPDATE users SET search_mode = ?, describe_tier = ? WHERE id = ?").bind(search_mode, describe_tier, user.id).run();
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

  if (resource === "account") {
    if (m === "GET" && !id) return json(await accountSummary(env.DB, user.id));
    if (m === "POST" && id === "delete") {
      const { confirm } = await req.json<{ confirm?: string }>();
      if (confirm !== CONFIRM) return json({ error: "confirm" }, 400);
      await deleteAccount(env, user);
      return json({ ok: true });
    }
  }

  if (resource === "export") {
    if (m === "GET") return json(await exportStatus(env, user.id));
    if (m === "POST") {
      const res = await startExport(env, user.id);
      if ("next_at" in res) return json(res, 429);
      // The bot posts the status message in the chat, as for /export; the link arrives as a reply.
      const msg = await botApi(env.BOT_TOKEN).sendMessage(user.id, t(lang, "export_started"), { parse_mode: "HTML" }).catch(() => null);
      if (msg) await setExportStatusMessage(env.DB, res.id, msg.message_id);
      return json(res);
    }
  }

  if (resource === "channels") {
    if (m === "GET" && !id) {
      const me = await botApi(env.BOT_TOKEN).getMe();
      return json({ channels: await listChannels(env.DB, user.id), addUrl: addChannelUrl(me.username) });
    }
    if (m === "PUT" && id) {
      const body = await req.json<{ enabled?: boolean; caption?: string }>();
      return (await updateChannel(env.DB, user.id, Number(id), body)) ? json({ ok: true }) : json({ error: "not found" }, 404);
    }
    if (m === "DELETE" && id) return (await removeChannel(env, user.id, Number(id))) ? json({ ok: true }) : json({ error: "not found" }, 404);
  }

  if (resource === "billing") {
    if (m === "GET" && !id) return json({ ...(await billingStatus(env, user)), methods: { btcpay: btcpayOn(env), usdt: usdtNetworks(env) } });
    if (m === "GET" && id === "crypto") {
      const inv = await getInvoice(env.DB, action);
      return inv?.user_id === user.id ? json({ id: inv.id, status: inv.status }) : json({ error: "not found" }, 404);
    }
    if (m !== "POST") return null;
    const body = await req.json<{ kind?: ProductKind; stars?: number; usd?: number; provider?: string; crypto?: string; on?: boolean }>();
    const kind = body.kind;
    if (id === "invoice" && kind) return json({ url: await starsInvoiceLink(botApi(env.BOT_TOKEN), user, lang, kind, body.stars) });
    if (id === "crypto" && kind) {
      const amount = productUsd(kind, ownKey(user), body.usd);
      if (amount === null) return json({ error: "bad product" }, 400);
      try {
        if (body.provider === "btcpay" && btcpayOn(env)) return json(await createBtcpayInvoice(env, user, kind, amount, body.crypto));
      } catch (e) {
        console.error("crypto checkout", e); // e.g. the processor's node is not synced
        return json({ error: "payment method unavailable" }, 503);
      }
      return json({ error: "method not available" }, 400);
    }
    if (id === "autorenew" && user.sub_charge_id) {
      await botApi(env.BOT_TOKEN).editUserStarSubscription(user.id, user.sub_charge_id, !body.on);
      await env.DB.prepare("UPDATE users SET sub_state = ? WHERE id = ?").bind(body.on ? "active" : "canceled", user.id).run();
      return json({ ok: true });
    }
  }

  if (resource === "admin") {
    if (user.role !== "admin") return json({ error: "admins only" }, 403);
    if (m === "GET" && id === "users") return json(await listUsers(env));
    if (id === "migrate") {
      // Storage migration on demand: re-key all objects and back-fill all Telegram-only memes into R2.
      const queued =
        m === "POST"
          ? { recovered: await recoverLostKeys(env), rekey: await queueRekey(env, 100_000), backfill: await queueHashBackfill(env, 100_000) }
          : null;
      const [rekey, backfill] = await env.DB.batch<{ n: number }>([
        env.DB.prepare(`SELECT COUNT(*) AS n FROM memes WHERE ${REKEY_WHERE}`),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM memes WHERE ${BACKFILL_WHERE}`),
      ]);
      return json({ queued, remaining: { rekey: rekey.results[0].n, backfill: backfill.results[0].n } });
    }
    const body = m === "POST" ? await req.json<{ target?: string; role?: string }>() : {};
    const api = botApi(env.BOT_TOKEN);
    if (m === "POST" && id === "grant") return json(await adminGrant(env, api, user, body.target ?? "", body.role));
    if (m === "POST" && id === "revoke") return json(await adminRevoke(env, api, user, body.target ?? ""));
  }
  return null;
}
