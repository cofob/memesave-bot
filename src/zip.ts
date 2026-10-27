import { botApi } from "./botapi";
import { EMBED_DIMS } from "./config";
import { Container, type StopParams } from "@cloudflare/containers";
import { userLang, type Kind } from "./db";
import type { Env } from "./env";
import { t, type Key, type Lang } from "./i18n";
import { namespace, upsertVectors } from "./ingest/embed";
import { insertMeme } from "./ingest/receive";
import { fileKey, previewKey, sign, signedQuery, tmpKey, verify, verifyQuery } from "./media";
import type { Job } from "./queue";
import { uploadPage } from "./uploadpage";

const LINK_TTL = 86400;
const blobKey = (userId: number, sha256: string) => `u/${userId}/${sha256}`;
const zipKey = (id: string) => tmpKey(`zip/${id}.zip`);

interface ZipImport {
  id: string;
  user_id: number;
  import_id: string;
  status: "uploading" | "running" | "done" | "failed";
  upload_id: string | null;
  total: number | null;
  imported: number;
  skipped: number;
  status_msg_id: number | null;
  format: string | null;
}

/** One-shot job container: unpacks one export and exits. `sleepAfter` is the hard timeout. */
export class ZipImporter extends Container<Env> {
  sleepAfter = "4h";
  enableInternet = true;

  async run(zipId: string, envVars: Record<string, string>) {
    await this.ctx.storage.put("zipId", zipId);
    await this.start({ envVars, enableInternet: true });
  }

  override async onStop({ exitCode }: StopParams) {
    const zipId = await this.ctx.storage.get<string>("zipId");
    // No-op when the container already reported done or fail.
    if (zipId) await failZip(this.env, zipId, `container stopped, exit code ${exitCode}`);
  }
}

interface ZipItem {
  sha256: string;
  kind: Kind;
  thumb?: boolean;
  mime?: string;
  file_size?: number;
  width?: number;
  height?: number;
  duration?: number;
  caption?: string;
  source?: string;
  restore?: Restore; // from a memesave export: saved as ready, without AI processing
}
const KINDS: Kind[] = ["photo", "video", "animation"];

/** Description and embeddings of a meme from a memesave export. */
interface Restore {
  title: string;
  description?: string;
  ocr_text?: string;
  speech_text?: string;
  meme_context?: string;
  cultural_meaning?: string;
  language?: string;
  tags?: string;
  search_phrases?: string;
  created_at?: number;
  image?: number[];
  text: number[];
}
const isVector = (v: unknown): v is number[] => Array.isArray(v) && v.length === EMBED_DIMS && v.every(Number.isFinite);
const FIELDS = ["title", "description", "ocr_text", "speech_text", "meme_context", "cultural_meaning", "language", "tags", "search_phrases"] as const;

/** Saves the exported description and vectors; false when they are incomplete (then the meme is processed normally). */
async function restoreMeme(env: Env, userId: number, memeId: string, kind: Kind, r: Restore | undefined) {
  if (!r?.title || !isVector(r.text)) return false;
  const text = (k: (typeof FIELDS)[number]) => (typeof r[k] === "string" && r[k] ? r[k] : null);
  const vectors = [{ id: `${memeId}:t`, values: r.text, namespace: namespace(userId), metadata: { kind } }];
  if (isVector(r.image)) vectors.push({ id: `${memeId}:i`, values: r.image, namespace: namespace(userId), metadata: { kind } });
  await upsertVectors(env, vectors);
  await env.DB.prepare(
    `UPDATE memes SET ${FIELDS.map((k) => `${k} = ?`).join(", ")}, status = 'ready', created_at = COALESCE(?, created_at), updated_at = unixepoch() WHERE id = ?`,
  )
    .bind(...FIELDS.map(text), Number(r.created_at) || null, memeId)
    .run();
  return true;
}

const getZip = (db: D1Database, id: string) => db.prepare("SELECT * FROM zip_imports WHERE id = ?").bind(id).first<ZipImport>();

async function say(env: Env, zip: ZipImport, key: Key, params: Record<string, string | number>, edit: boolean) {
  const text = t(await userLang(env.DB, zip.user_id), key, params);
  const api = botApi(env.BOT_TOKEN);
  const html = { parse_mode: "HTML" } as const;
  const reply = zip.status_msg_id ? { reply_parameters: { message_id: zip.status_msg_id, allow_sending_without_reply: true } } : {};
  const sent =
    edit && zip.status_msg_id ? api.editMessageText(zip.user_id, zip.status_msg_id, text, html) : api.sendMessage(zip.user_id, text, { ...html, ...reply });
  await sent.catch(console.error);
}

/** "telegram_html,files" → "Telegram HTML export + media files" in the user's language. */
const formatLabel = (format: string | null, lang: Lang) =>
  (format ? format.split(",") : ["files"]).map((f) => t(lang, `fmt_${f}` as Key)).join(" + ");

/** Edits the progress message at most once per 5 s (Telegram limits message edits); web imports have none. */
async function progress(env: Env, zip: ZipImport, params: Record<string, string | number>) {
  if (!zip.status_msg_id) return;
  const due = await env.DB.prepare(
    "UPDATE zip_imports SET edited_at = unixepoch() WHERE id = ? AND (edited_at IS NULL OR edited_at <= unixepoch() - 5) RETURNING id",
  )
    .bind(zip.id)
    .first();
  if (due) await say(env, zip, "zip_progress", { ...params, format: formatLabel(zip.format, await userLang(env.DB, zip.user_id)) }, true);
}

/** /batch_zip: opens batch mode if needed and returns the text and upload link for a new zip import. */
export async function createZipImport(env: Env, userId: number, lang: Lang) {
  // Each archive gets its own batch: its photos are submitted when the import ends, without /batch_finish.
  const importId = crypto.randomUUID().replaceAll("-", "");
  const id = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare("INSERT INTO zip_imports (id, user_id, import_id, status) VALUES (?, ?, ?, 'uploading')").bind(id, userId, importId).run();
  const url = `${env.PUBLIC_URL.replace(/\/$/, "")}/upload/${id}${await signedQuery(env, `upload|${id}`, LINK_TTL)}`;
  return { id, url, text: t(lang, "zip_link"), button: { text: t(lang, "zip_button"), url } };
}

/** Progress of a zip import for the web app. */
export const zipStatus = (db: D1Database, id: string, userId: number) =>
  db
    .prepare("SELECT id, status, total, imported, skipped, format, error FROM zip_imports WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first();

export const setZipStatusMessage = (db: D1Database, id: string, messageId: number) =>
  db.prepare("UPDATE zip_imports SET status_msg_id = ? WHERE id = ?").bind(messageId, id).run();

/** Marks a running or uploading zip import failed, deletes the archive and tells the user. */
/** Submits the archive's photos as a half-price batch (the import row is created only now). */
async function submitZipPhotos(env: Env, zip: ZipImport) {
  const photos = await env.DB.prepare("SELECT 1 FROM memes WHERE import_id = ? LIMIT 1").bind(zip.import_id).first();
  if (!photos) return;
  await env.DB.prepare("INSERT OR IGNORE INTO imports (id, user_id, status, status_msg_id) VALUES (?, ?, 'submitting', ?)")
    .bind(zip.import_id, zip.user_id, zip.status_msg_id)
    .run();
  await env.JOBS.send({ type: "batch_submit", importId: zip.import_id });
}

export async function failZip(env: Env, id: string, error: string) {
  const zip = await env.DB.prepare(
    "UPDATE zip_imports SET status = 'failed', error = ?, updated_at = unixepoch() WHERE id = ? AND status IN ('uploading', 'running') RETURNING *",
  )
    .bind(error.slice(0, 1000), id)
    .first<ZipImport>();
  if (!zip) return;
  await env.MEDIA.delete(zipKey(id));
  await say(env, zip, "zip_failed", { error: error.slice(0, 300).replace(/[<>&]/g, "") }, false);
  await submitZipPhotos(env, zip); // photos saved before the failure still get described
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** /upload/<id>[/start|/part|/complete] — upload page and R2 multipart upload, authorized by the signed link. */
export async function handleUpload(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const [, , id = "", action = ""] = url.pathname.split("/");
  const zip = (await verifyQuery(env, `upload|${id}`, url)) ? await getZip(env.DB, id) : null;
  if (!zip) return new Response("Link is invalid or expired", { status: 403 });
  const lang = await userLang(env.DB, zip.user_id);
  if (!action && req.method === "GET") return uploadPage(lang, zip.status === "uploading");
  if (zip.status !== "uploading") return json({ error: "already uploaded" }, 409);

  if (action === "start" && req.method === "POST") {
    const upload = await env.MEDIA.createMultipartUpload(zipKey(id), { httpMetadata: { contentType: "application/zip" } });
    await env.DB.prepare("UPDATE zip_imports SET upload_id = ?, updated_at = unixepoch() WHERE id = ?").bind(upload.uploadId, id).run();
    return json({ ok: true });
  }
  if (!zip.upload_id) return json({ error: "upload not started" }, 409);
  const upload = env.MEDIA.resumeMultipartUpload(zipKey(id), zip.upload_id);

  if (action === "part" && req.method === "PUT" && req.body) {
    const part = await upload.uploadPart(Number(url.searchParams.get("n")), req.body);
    return json(part);
  }
  if (action === "complete" && req.method === "POST") {
    // One running container per user: a user cannot take all instances from other users.
    const busy = await env.DB.prepare("SELECT 1 FROM zip_imports WHERE user_id = ? AND status = 'running'").bind(zip.user_id).first();
    if (busy) return json({ error: "another import is running" }, 409);
    const { parts } = await req.json<{ parts: R2UploadedPart[] }>();
    await upload.complete(parts);
    await env.DB.prepare("UPDATE zip_imports SET status = 'running', updated_at = unixepoch() WHERE id = ?").bind(id).run();
    const base = `${env.PUBLIC_URL.replace(/\/$/, "")}/zip/${id}`;
    const stub = env.ZIP.get(env.ZIP.idFromName(id));
    await stub.run(id, { ZIP_URL: `${base}/file`, API_URL: base, TOKEN: await sign(env, `zip|${id}`) });
    ctx.waitUntil(say(env, zip, "zip_unpacking", {}, true));
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

/** /zip/<id>/(file|filter|items|done|fail) — calls from the container, authorized by a per-import token. */
export async function handleZipCallback(req: Request, env: Env): Promise<Response> {
  const [, , id = "", action = ""] = new URL(req.url).pathname.split("/");
  const token = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const zip = (await verify(env, `zip|${id}`, token)) ? await getZip(env.DB, id) : null;
  if (zip?.status !== "running") return json({ error: "not running" }, 403);
  const db = env.DB;

  if (action === "file") {
    const obj = await env.MEDIA.get(zipKey(id));
    return obj ? new Response(obj.body, { headers: { "Content-Length": String(obj.size) } }) : json({ error: "no file" }, 404);
  }
  if (action === "blob" && req.method === "PUT" && req.body) {
    // PUT /zip/<id>/blob/<sha256>[?thumb=1]: the permanent copy of a file (or its preview) in R2.
    const sha = new URL(req.url).pathname.split("/")[4] ?? "";
    if (!/^[0-9a-f]{64}$/.test(sha)) return json({ error: "bad sha256" }, 400);
    const thumb = new URL(req.url).searchParams.has("thumb");
    const contentType = req.headers.get("Content-Type") ?? "application/octet-stream";
    const base = blobKey(zip.user_id, sha);
    await env.MEDIA.put(thumb ? previewKey(base) : fileKey(base, contentType), req.body, {
      httpMetadata: { contentType },
    });
    return json({ ok: true });
  }
  const body = await req.json<any>();

  if (action === "filter") {
    const hashes: string[] = body.hashes ?? [];
    const known = new Set<string>();
    for (let i = 0; i < hashes.length; i += 90) {
      const chunk = hashes.slice(i, i + 90);
      const { results } = await db
        .prepare(`SELECT sha256 FROM memes WHERE user_id = ? AND sha256 IN (${chunk.map(() => "?").join(",")})`)
        .bind(zip.user_id, ...chunk)
        .all<{ sha256: string }>();
      results.forEach((r) => known.add(r.sha256));
    }
    const fresh = hashes.filter((h) => !known.has(h));
    const skipped = Number(body.found ?? hashes.length) - fresh.length;
    const formats = ["memesave", "telegram_json", "telegram_html", "files"];
    const format = ((body.formats ?? []) as string[]).filter((f) => formats.includes(f)).join(",") || null;
    await db.prepare("UPDATE zip_imports SET total = ?, skipped = ?, format = ?, updated_at = unixepoch() WHERE id = ?")
      .bind(fresh.length, skipped, format, id)
      .run();
    zip.format = format;
    await progress(env, zip, { found: body.found ?? hashes.length, total: fresh.length, skipped, done: 0 });
    return json({ new: fresh });
  }

  if (action === "items") {
    // Photos go to the archive's own batch; videos and GIFs use the normal pipeline; exported memes are restored.
    const jobs: { body: Job }[] = [];
    let restored = 0;
    for (const item of body.items as ZipItem[]) {
      if (!/^[0-9a-f]{64}$/.test(item.sha256) || !KINDS.includes(item.kind)) continue;
      // Imported files live in R2; they get Telegram file ids on their first send ("r2:<sha256>" until then).
      const memeId = await insertMeme(db, zip.user_id, {
        kind: item.kind,
        file_id: "",
        file_unique_id: `r2:${item.sha256}`,
        preview_file_id: null,
        preview_unique_id: null,
        // Same keys as the blob upload: the container sends the same MIME type for both.
        r2_file: fileKey(blobKey(zip.user_id, item.sha256), item.mime ?? "application/octet-stream"),
        r2_preview: item.thumb ? previewKey(blobKey(zip.user_id, item.sha256)) : null,
        mime: item.mime ?? null,
        file_size: item.file_size ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        duration: item.duration ?? null,
        caption: item.caption || null,
        source: item.source || null,
        import_id: item.kind === "photo" && !item.restore ? zip.import_id : null,
        sha256: item.sha256,
      });
      if (!memeId) continue;
      if (await restoreMeme(env, zip.user_id, memeId, item.kind, item.restore)) restored++;
      else jobs.push({ body: { type: "embed", memeId } });
    }
    if (jobs.length) await env.JOBS.sendBatch(jobs);
    const done = await db
      .prepare("UPDATE zip_imports SET imported = imported + ?, updated_at = unixepoch() WHERE id = ? RETURNING imported")
      .bind(jobs.length + restored, id)
      .first<number>("imported");
    await progress(env, zip, { found: (zip.total ?? 0) + zip.skipped, total: zip.total ?? 0, skipped: zip.skipped, done: done ?? 0 });
    return json({ ok: true });
  }

  if (action === "done") {
    await db.prepare("UPDATE zip_imports SET status = 'done', updated_at = unixepoch() WHERE id = ?").bind(id).run();
    await env.MEDIA.delete(zipKey(id));
    await say(env, zip, "zip_done", { imported: zip.imported, skipped: zip.skipped, failed: Number(body.failed ?? 0) }, false);
    await submitZipPhotos(env, zip);
    return json({ ok: true });
  }

  if (action === "fail") {
    await failZip(env, id, String(body.error ?? "unknown error"));
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

/** Cron: forget upload links that were never used. */
export const expireZipUploads = (db: D1Database) =>
  db
    .prepare("UPDATE zip_imports SET status = 'failed', error = 'upload expired' WHERE status = 'uploading' AND created_at < unixepoch() - ?")
    .bind(LINK_TTL)
    .run();
