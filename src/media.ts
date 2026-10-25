import { Buffer } from "node:buffer";
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

/**
 * Imported memes not yet sent to Telegram have file_unique_id "r2:<sha256>" (preview "r2p:<sha256>")
 * and keep their bytes in the persistent MEDIA bucket under "r2/<sha256>" ("r2p/<sha256>").
 */
export const isStored = (uniqueId: string | null | undefined) => !!uniqueId && /^r2p?:/.test(uniqueId);
export const storedKey = (uniqueId: string) => uniqueId.replace(":", "/");

/** File and unique id of the preview (thumbnail or 640 px photo), or of the file itself. */
export const previewOf = (m: { file_id: string; file_unique_id: string; preview_file_id: string | null; preview_unique_id: string | null }) =>
  m.preview_unique_id ? ([m.preview_file_id ?? "", m.preview_unique_id] as const) : ([m.file_id, m.file_unique_id] as const);

/** Returns file bytes: stored imports from MEDIA, Telegram files from the 7-day cache or Telegram. */
export async function getMedia(env: Env, fileId: string, uniqueId: string, fallbackMime: string): Promise<Media> {
  if (isStored(uniqueId)) {
    const obj = await env.MEDIA.get(storedKey(uniqueId));
    if (!obj) throw new Error(`Stored media missing: ${uniqueId}`);
    return { bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType ?? fallbackMime };
  }
  const key = `m/${uniqueId}`;
  const hit = await env.CACHE.get(key);
  if (hit) return { bytes: await hit.arrayBuffer(), mime: hit.httpMetadata?.contentType ?? fallbackMime };

  const info = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const { ok, result } = await info.json<{ ok: boolean; result?: { file_path?: string } }>();
  if (!ok || !result?.file_path) throw new Error(`getFile failed for ${uniqueId}`);
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${result.file_path}`);
  if (!res.ok) throw new Error(`Telegram download ${res.status} for ${uniqueId}`);

  const bytes = await res.arrayBuffer();
  const mime = EXT_MIME[result.file_path.split(".").pop()!.toLowerCase()] ?? fallbackMime;
  await env.CACHE.put(key, bytes, { httpMetadata: { contentType: mime } });
  return { bytes, mime };
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

/** Public URL of a cached file for providers that only accept https images (OpenRouter Batch). */
const MIME_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_MIME).map(([ext, mime]) => [mime, ext]));

/**
 * Public URL of a file for providers that only accept https media (OpenRouter Batch, inline results).
 * The path ends with a file extension: Vertex batch rejects image URLs without one.
 */
export async function signedMediaUrl(env: Env, uniqueId: string, ttlSeconds: number, mime = "image/jpeg", base = env.PUBLIC_URL) {
  const ext = MIME_EXT[mime] ?? "jpg";
  return `${base.replace(/\/$/, "")}/media/${uniqueId}.${ext}${await signedQuery(env, uniqueId, ttlSeconds)}`;
}

/** GET /media/<uniqueId>.<ext>?e=&s= — serves a file from R2 when the signature is valid and not expired. */
export async function serveMedia(req: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(req.url);
  const uniqueId = decodeURIComponent(url.pathname.split("/")[2] ?? "").replace(/\.[a-z0-9]+$/i, "");
  if (!(await verifyQuery(env, uniqueId, url))) return new Response("Not found", { status: 404 });
  return cachedMedia(req, ctx, async () => {
    const obj = await (isStored(uniqueId) ? env.MEDIA.get(storedKey(uniqueId)) : env.CACHE.get(`m/${uniqueId}`));
    return obj && new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream" } });
  });
}
