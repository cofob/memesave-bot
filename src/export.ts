import { Container, type StopParams } from "@cloudflare/containers";
import { botApi } from "./botapi";
import { getMeme, userLang } from "./db";
import type { Env } from "./env";
import { t, type Key } from "./i18n";
import { memeMedia, sign, signedQuery, tmpKey, variantOf, verify, verifyQuery } from "./media";

const DAY = 86400;
const LINK_TTL = 7 * DAY; // the bucket deletes "tmp/" after 7 days
const PAGE = 500;
const exportKey = (id: string) => tmpKey(`export/${id}.zip`);

interface Export {
  id: string;
  user_id: number;
  status: "running" | "done" | "failed";
  upload_id: string | null;
  size: number | null;
  files: number | null;
  failed: number | null;
  status_msg_id: number | null;
  error: string | null;
  created_at: number;
}

/**
 * Exported columns of the user's rows. A whitelist: secrets and internal handles (OpenRouter key,
 * Telegram file ids, payment charge ids, R2 keys, message ids) stay out, also in columns added later.
 */
const TABLES: Record<string, { from: string; where: string; cols: string }> = {
  profile: {
    from: "users",
    where: "id = ?",
    cols: "id, username, role, lang, search_mode, describe_tier, total_cost, plan, plan_byok, paid_until, allowance_until, plan_started, balance, sub_state, created_at",
  },
  memes: {
    from: "memes",
    where: "user_id = ?",
    cols: "id, kind, mime, file_size, width, height, duration, caption, source, tg_meta, status, title, description, ocr_text, speech_text, meme_context, cultural_meaning, language, tags, search_phrases, import_id, sha256, error, created_at, updated_at, COALESCE(r2_file, '') != '' AS has_file, r2_preview IS NOT NULL AS has_preview",
  },
  transactions: {
    from: "transactions",
    where: "user_id = ?",
    cols: "id, kind, model, key_source, cost, prompt_tokens, completion_tokens, meme_id, from_allowance, from_balance, created_at",
  },
  imports: { from: "imports", where: "user_id = ?", cols: "id, status, key_source, model, attempts, described, cost, error, created_at, updated_at" },
  zip_imports: { from: "zip_imports", where: "user_id = ?", cols: "id, import_id, status, total, imported, skipped, format, error, created_at, updated_at" },
  payments: { from: "payments", where: "user_id = ?", cols: "id, method, kind, byok, stars, usd, recurring, refunded, created_at" },
  crypto_invoices: {
    from: "crypto_invoices",
    where: "user_id = ?",
    cols: "id, provider, kind, byok, usd, crypto, crypto_amount, status, credited_usd, created_at, paid_at",
  },
  exports: { from: "exports", where: "user_id = ?", cols: "id, status, size, files, failed, error, created_at" },
};

/** One-shot job container (same image as the importer, MODE=export): builds one export and exits. */
export class DataExporter extends Container<Env> {
  sleepAfter = "4h";
  enableInternet = true;

  async run(exportId: string, envVars: Record<string, string>) {
    await this.ctx.storage.put("exportId", exportId);
    await this.start({ envVars, enableInternet: true });
  }

  override async onStop({ exitCode }: StopParams) {
    const exportId = await this.ctx.storage.get<string>("exportId");
    // No-op when the container already reported done or fail.
    if (exportId) await failExport(this.env, exportId, `container stopped, exit code ${exitCode}`);
  }
}

const getExport = (db: D1Database, id: string) => db.prepare("SELECT * FROM exports WHERE id = ?").bind(id).first<Export>();
const base = (env: Env) => env.PUBLIC_URL.replace(/\/$/, "");

async function say(env: Env, ex: Export, key: Key, params: Record<string, string | number> = {}, extra: object = {}) {
  const text = t(await userLang(env.DB, ex.user_id), key, params);
  const reply = ex.status_msg_id ? { reply_parameters: { message_id: ex.status_msg_id, allow_sending_without_reply: true } } : {};
  await botApi(env.BOT_TOKEN).sendMessage(ex.user_id, text, { parse_mode: "HTML", ...reply, ...extra }).catch(console.error);
}

export const downloadUrl = async (env: Env, id: string) =>
  `${base(env)}/export/${id}/download${await signedQuery(env, `export_dl|${id}`, LINK_TTL)}`;

/** Starts an export, or returns when the next one is allowed (one per day; failed ones do not count). */
export async function startExport(env: Env, userId: number): Promise<{ id: string } | { next_at: number }> {
  const last = await env.DB.prepare(
    "SELECT created_at FROM exports WHERE user_id = ? AND status != 'failed' AND created_at > unixepoch() - ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(userId, DAY)
    .first<number>("created_at");
  if (last) return { next_at: last + DAY };
  const id = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare("INSERT INTO exports (id, user_id, status) VALUES (?, ?, 'running')").bind(id, userId).run();
  const stub = env.EXPORT.get(env.EXPORT.idFromName(id));
  await stub.run(id, { MODE: "export", API_URL: `${base(env)}/export/${id}`, TOKEN: await sign(env, `export|${id}`) });
  return { id };
}

export const setExportStatusMessage = (db: D1Database, id: string, messageId: number) =>
  db.prepare("UPDATE exports SET status_msg_id = ? WHERE id = ?").bind(messageId, id).run();

/** The latest export for the web app, with the download link while it is kept. */
export async function exportStatus(env: Env, userId: number) {
  const ex = await env.DB.prepare("SELECT * FROM exports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").bind(userId).first<Export>();
  if (!ex) return null;
  const now = Date.now() / 1000;
  return {
    id: ex.id,
    status: ex.status,
    size: ex.size,
    error: ex.error,
    created_at: ex.created_at,
    next_at: ex.status === "failed" ? null : ex.created_at + DAY,
    url: ex.status === "done" && ex.created_at > now - LINK_TTL ? await downloadUrl(env, ex.id) : null,
  };
}

export async function failExport(env: Env, id: string, error: string) {
  const ex = await env.DB.prepare(
    "UPDATE exports SET status = 'failed', error = ?, updated_at = unixepoch() WHERE id = ? AND status = 'running' RETURNING *",
  )
    .bind(error.slice(0, 1000), id)
    .first<Export>();
  if (!ex) return;
  if (ex.upload_id) await env.MEDIA.resumeMultipartUpload(exportKey(id), ex.upload_id).abort().catch(console.error);
  await say(env, ex, "export_failed", { error: error.slice(0, 300).replace(/[<>&]/g, "") });
}

/** Cron: safety net for exports whose container never reported back. */
export const expireExports = (db: D1Database) =>
  db
    .prepare("UPDATE exports SET status = 'failed', error = 'timeout' WHERE status = 'running' AND created_at < unixepoch() - 5 * 3600")
    .run();

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A page of the user's rows of one table: `{ columns, rows, next }`, ordered by rowid. */
async function tablePage(db: D1Database, userId: number, name: string, after: number) {
  const table = TABLES[name];
  if (!table) return json({ error: "unknown table" }, 400);
  const [columns = [], ...rows] = await db
    .prepare(`SELECT rowid AS _r, ${table.cols} FROM ${table.from} WHERE ${table.where} AND rowid > ? ORDER BY rowid LIMIT ?`)
    .bind(userId, after, PAGE)
    .raw({ columnNames: true });
  const next = rows.length === PAGE ? rows[rows.length - 1][0] : null;
  return json({ columns: columns.slice(1), rows: rows.map((r) => r.slice(1)), next });
}

/** /export/<id>/download (signed link) and container calls /export/<id>/<action> (per-export token). */
export async function handleExport(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const [, , id = "", action = "", arg = "", variant = ""] = url.pathname.split("/");

  if (action === "download" && req.method === "GET") {
    const obj = (await verifyQuery(env, `export_dl|${id}`, url)) ? await env.MEDIA.get(exportKey(id)) : null;
    if (!obj) return new Response("Link is invalid or expired", { status: 404 });
    const date = obj.uploaded.toISOString().slice(0, 10);
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(obj.size),
        "Content-Disposition": `attachment; filename="memesave-export-${date}.zip"`,
      },
    });
  }

  const token = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const ex = (await verify(env, `export|${id}`, token)) ? await getExport(env.DB, id) : null;
  if (ex?.status !== "running") return json({ error: "not running" }, 403);

  if (action === "table" && req.method === "GET") return tablePage(env.DB, ex.user_id, arg, Number(url.searchParams.get("after")) || 0);

  if (action === "vectors" && req.method === "GET") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 10);
    if (!ids.length) return json([]);
    const { results } = await env.DB.prepare(`SELECT id FROM memes WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(ex.user_id, ...ids)
      .all<{ id: string }>();
    if (!results.length) return json([]);
    const vectors = await env.VECTORS.getByIds(results.flatMap((r) => [`${r.id}:i`, `${r.id}:t`]));
    return json(vectors.map((v) => ({ id: v.id, values: Array.from(v.values), metadata: v.metadata ?? null })));
  }

  if (action === "media" && req.method === "GET") {
    const m = await getMeme(env.DB, arg);
    // A meme without its own preview would only repeat the file.
    if (m?.user_id !== ex.user_id || (variant !== "file" && variant !== "preview") || variantOf(m, variant) !== variant) {
      return json({ error: "not found" }, 404);
    }
    const media = await memeMedia(env, m, variant).catch(() => null);
    return media ? new Response(media.bytes, { headers: { "Content-Type": media.mime } }) : json({ error: "not found" }, 404);
  }

  if (action === "start" && req.method === "POST") {
    const upload = await env.MEDIA.createMultipartUpload(exportKey(id), { httpMetadata: { contentType: "application/zip" } });
    await env.DB.prepare("UPDATE exports SET upload_id = ?, updated_at = unixepoch() WHERE id = ?").bind(upload.uploadId, id).run();
    return json({ ok: true });
  }
  if ((action === "part" || action === "complete") && !ex.upload_id) return json({ error: "upload not started" }, 409);
  if (action === "part" && req.method === "PUT" && req.body) {
    const upload = env.MEDIA.resumeMultipartUpload(exportKey(id), ex.upload_id!);
    return json(await upload.uploadPart(Number(url.searchParams.get("n")), req.body));
  }

  const body = await req.json<any>();
  if (action === "complete") {
    await env.MEDIA.resumeMultipartUpload(exportKey(id), ex.upload_id!).complete(body.parts as R2UploadedPart[]);
    return json({ ok: true });
  }
  if (action === "done") {
    const done = { size: Number(body.size) || 0, files: Number(body.files) || 0, failed: Number(body.failed) || 0 };
    await env.DB.prepare("UPDATE exports SET status = 'done', size = ?, files = ?, failed = ?, updated_at = unixepoch() WHERE id = ?")
      .bind(done.size, done.files, done.failed, id)
      .run();
    const lang = await userLang(env.DB, ex.user_id);
    const button = { text: t(lang, "export_button"), url: await downloadUrl(env, id) };
    await say(env, ex, "export_done", { ...done, size: (done.size / 2 ** 20).toFixed(1) }, { reply_markup: { inline_keyboard: [[button]] } });
    return json({ ok: true });
  }
  if (action === "fail") {
    await failExport(env, id, String(body.error ?? "unknown error"));
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}
