import { botApi } from "./botapi";
import { webhookCallback } from "grammy";
import { createBot } from "./bot";
import { syncCommands } from "./botcommands";
import type { Env } from "./env";
import { expireExports, handleExport } from "./export";
import { queueHashBackfill } from "./ingest/embed";
import { queueRekey } from "./rekey";
import { handleBatch, type Job } from "./queue";
import { oauthCallback } from "./userkey";
import { serveMedia } from "./media";
import { handleLogin } from "./login";
import { handleApp } from "./webapp";
import { billingNotices } from "./billing";
import { handleBtcpay } from "./crypto";
import { expireZipUploads, handleUpload, handleZipCallback } from "./zip";

export { ZipImporter } from "./zip";
export { DataExporter } from "./export";

let handler: ((req: Request) => Promise<Response>) | undefined;
let synced: Promise<unknown> | undefined;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/oauth/callback") return oauthCallback(req, env);
    if (req.method === "GET" && url.pathname.startsWith("/media/")) return serveMedia(req, env, ctx);
    if (url.pathname.startsWith("/upload/")) return handleUpload(req, env, ctx);
    if (url.pathname.startsWith("/app")) return (await handleApp(req, env, ctx)) ?? new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/auth/")) return (await handleLogin(req, env)) ?? new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/zip/")) return handleZipCallback(req, env);
    if (req.method === "POST" && url.pathname === "/pay/btcpay") return handleBtcpay(req, env);
    if (url.pathname.startsWith("/export/")) return handleExport(req, env);
    if (req.method === "POST" && url.pathname === "/batch/webhook") {
      // Only a hint: the poll re-reads every batch from OpenRouter with our key.
      await env.JOBS.send({ type: "batch_poll" });
      return new Response("OK");
    }
    if (req.method !== "POST" || url.pathname !== "/webhook") return new Response("Not found", { status: 404 });
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    synced ??= syncCommands(env, botApi(env.BOT_TOKEN)).catch((e) => {
      synced = undefined;
      console.error("command sync failed", e);
    });
    ctx.waitUntil(synced);
    handler ??= webhookCallback(createBot(env), "cloudflare-mod", { timeoutMilliseconds: 55_000, onTimeout: "return" });
    return handler(req);
  },
  queue: handleBatch,
  async scheduled(_, env) {
    await expireZipUploads(env.DB);
    await expireExports(env.DB);
    await queueHashBackfill(env);
    await queueRekey(env);
    await billingNotices(env);
    if (await env.DB.prepare("SELECT 1 FROM imports WHERE status = 'submitted' LIMIT 1").first()) await env.JOBS.send({ type: "batch_poll" });
  },
} satisfies ExportedHandler<Env, Job>;
