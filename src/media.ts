import { Buffer } from "node:buffer";
import type { Meme } from "./db";
import type { Env } from "./env";

export interface Media {
  bytes: ArrayBuffer;
  mime: string;
}

const EXT_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg", // after "jpeg": the reverse map picks the last extension
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/mov",
  webm: "video/webm",
};

/** The meme fields media access needs. */
export type MediaMeme = Pick<Meme, "id" | "kind" | "mime" | "file_id" | "preview_file_id" | "r2_file" | "r2_preview">;
export type Variant = "file" | "preview";

/** Temporary objects (query embeddings, inline cache, zip uploads): the bucket expires "tmp/" after 7 days. */
export const tmpKey = (name: string) => `tmp/${name}`;

/** "preview" when the meme has its own preview (Telegram thumbnail / 640 px size, uploaded thumbnail), else "file". */
export const variantOf = (m: MediaMeme, v: Variant): Variant => (v === "preview" && (m.r2_preview || m.preview_file_id) ? "preview" : "file");

const fallbackMime = (m: MediaMeme, v: Variant) => (v === "preview" ? "image/jpeg" : (m.mime ?? (m.kind === "photo" ? "image/jpeg" : "video/mp4")));

async function downloadTelegram(env: Env, fileId: string, fallback: string): Promise<Media> {
  const info = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const { ok, result } = await info.json<{ ok: boolean; result?: { file_path?: string } }>();
  if (!ok || !result?.file_path) throw new Error(`getFile failed for ${fileId}`);
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${result.file_path}`);
  if (!res.ok) throw new Error(`Telegram download ${res.status} for ${fileId}`);
  return { bytes: await res.arrayBuffer(), mime: EXT_MIME[result.file_path.split(".").pop()!.toLowerCase()] ?? fallback };
}

/**
 * Bytes of a meme's file or preview. Every meme keeps a permanent copy in R2 (MEDIA); a meme that is only
 * in Telegram is downloaded once and saved there (back-fill). Bot API downloads are limited to 20 MB.
 */
export async function memeMedia(env: Env, m: MediaMeme, variant: Variant): Promise<Media> {
  const v = variantOf(m, variant);
  const key = v === "preview" ? m.r2_preview : m.r2_file;
  const fallback = fallbackMime(m, v);
  if (key) {
    const obj = await env.MEDIA.get(key);
    if (obj) return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType ?? fallback };
  }
  const fileId = v === "preview" ? m.preview_file_id : m.file_id;
  if (!fileId) throw new Error(`No ${v} for meme ${m.id}`);
  const media = await downloadTelegram(env, fileId, fallback);
  const newKey = `memes/${m.id}/${v}`;
  await env.MEDIA.put(newKey, media.bytes, { httpMetadata: { contentType: media.mime } });
  await env.DB.prepare(`UPDATE memes SET ${v === "preview" ? "r2_preview" : "r2_file"} = ? WHERE id = ?`).bind(newKey, m.id).run();
  if (v === "preview") m.r2_preview = newKey;
  else m.r2_file = newKey;
  return media;
}

export const toDataUrl = ({ bytes, mime }: Media) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(`media|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

/** HMAC-SHA256 of `msg` with a key derived from ENCRYPTION_KEY, base64url. */
export const sign = async (env: Env, msg: string) =>
  Buffer.from(await crypto.subtle.sign("HMAC", await hmacKey(env.ENCRYPTION_KEY), new TextEncoder().encode(msg))).toString("base64url");

export const verify = async (env: Env, msg: string, sig: string) =>
  crypto.subtle.verify("HMAC", await hmacKey(env.ENCRYPTION_KEY), Buffer.from(sig, "base64url"), new TextEncoder().encode(msg));

const DAY = 86400;

/**
 * `?e=<exp>&s=<sig>` for `scope`, valid at least `ttlSeconds`. The expiry is rounded up to a whole day,
 * so the URL stays the same all day: browsers and Telegram cache media by URL.
 */
export async function signedQuery(env: Env, scope: string, ttlSeconds: number) {
  const exp = Math.ceil((Math.floor(Date.now() / 1000) + ttlSeconds) / DAY) * DAY;
  return `?e=${exp}&s=${await sign(env, `${scope}|${exp}`)}`;
}

/**
 * Media behind a signed URL never changes, so it is cached until the URL expires: by the browser,
 * by Telegram and by Cloudflare's edge cache (repeat requests skip R2 and Telegram).
 */
export async function cachedMedia(req: Request, ctx: ExecutionContext, load: () => Promise<Response | null>): Promise<Response> {
  const hit = await caches.default.match(req);
  if (hit) return hit;
  const res = await load();
  if (!res) return new Response("Not found", { status: 404 });
  const maxAge = Math.max(0, Number(new URL(req.url).searchParams.get("e")) - Math.floor(Date.now() / 1000));
  res.headers.set("Cache-Control", `public, max-age=${maxAge}, immutable`);
  ctx.waitUntil(caches.default.put(req, res.clone()));
  return res;
}

export async function verifyQuery(env: Env, scope: string, url: URL) {
  const exp = Number(url.searchParams.get("e"));
  return exp > Date.now() / 1000 && verify(env, `${scope}|${exp}`, url.searchParams.get("s") ?? "");
}

const MIME_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_MIME).map(([ext, mime]) => [mime, ext]));

/**
 * Public URL of a meme's file or preview for providers that only accept https media (OpenRouter Batch,
 * inline results). The path ends with a file extension: Vertex batch rejects image URLs without one.
 */
export async function signedMediaUrl(env: Env, m: MediaMeme, variant: Variant, ttlSeconds: number, base = env.PUBLIC_URL) {
  const v = variantOf(m, variant);
  const ext = MIME_EXT[fallbackMime(m, v)] ?? "jpg";
  return `${base.replace(/\/$/, "")}/media/${m.id}.${v}.${ext}${await signedQuery(env, `media|${m.id}|${v}`, ttlSeconds)}`;
}

/** GET /media/<memeId>.<file|preview>.<ext>?e=&s= — the meme's media from R2 (back-filled from Telegram when needed). */
export async function serveMedia(req: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(req.url);
  const [id = "", variant = ""] = (url.pathname.split("/")[2] ?? "").split(".");
  if ((variant !== "file" && variant !== "preview") || !(await verifyQuery(env, `media|${id}|${variant}`, url))) {
    return new Response("Not found", { status: 404 });
  }
  return cachedMedia(req, ctx, async () => {
    const m = await env.DB.prepare("SELECT * FROM memes WHERE id = ?").bind(id).first<Meme>();
    if (!m) return null;
    const media = await memeMedia(env, m, variant).catch(() => null);
    return media && new Response(media.bytes, { headers: { "Content-Type": media.mime } });
  });
}
