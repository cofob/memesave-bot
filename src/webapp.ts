import { botApi } from "./botapi";
import type { User as TgUser } from "grammy/types";
import { resolveUser } from "./auth";
import { deleteMeme, deleteMemes, getMeme, getUser, type Kind, type Meme, type User } from "./db";
import { insertMeme } from "./ingest/receive";
import { collectingImport } from "./batch";
import { MODELS } from "./config";
import { handleAccount } from "./webaccount";
import { addToPost, albumMemes } from "./channels";
import { billingStatus, canUseAi } from "./billing";
import { facets, filterSql } from "./filters";
import { getCookie, readSession } from "./session";
import { TOKEN_PREFIX, tokenUser } from "./tokens";
import { serveOpenapi } from "./openapi";
import type { Env } from "./env";
import { cachedMedia, extOf, fileKey, memeMedia, previewKey, signedQuery, verifyQuery } from "./media";
import { sendAlbum, sendMeme, toInlineResult } from "./search/deliver";
import { agentSearch } from "./search/agent";
import { keywordSearch } from "./search/hybrid";
import { cachedFastSearch } from "./search/inline";

const PAGE = 60;
const URL_TTL = 86400;
const FILE_MAX = 20 * 1024 * 1024; // Bot API getFile limit
const enc = (s: string) => new TextEncoder().encode(s);

async function hmac(key: BufferSource, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Validates Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). */
export async function checkInitData(botToken: string, initData: string, maxAgeSeconds = 86400): Promise<TgUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc("WebAppData"), botToken);
  if (hex(await hmac(secret, dataCheck)) !== hash) return null;
  if (Date.now() / 1000 - Number(params.get("auth_date")) > maxAgeSeconds) return null;
  return JSON.parse(params.get("user") ?? "null");
}

const base = (env: Env) => env.PUBLIC_URL.replace(/\/$/, "");
// Telegram-only files over 20 MB cannot be downloaded by the bot; R2 copies always can be served.
const fileFits = (m: Meme) => !!m.r2_file || m.kind === "photo" || (m.file_size ?? Infinity) <= FILE_MAX;

export async function brief(env: Env, m: Meme) {
  return {
    id: m.id,
    kind: m.kind,
    title: m.title,
    status: m.status,
    tags: m.tags ? m.tags.split("\n") : [],
    thumb: `${base(env)}/app/thumb/${m.id}${await signedQuery(env, `thumb|${m.id}`, URL_TTL)}`,
    // Metadata for client-side filtering of search results.
    width: m.width,
    height: m.height,
    duration: m.duration,
    language: m.language,
    has_text: !!m.ocr_text,
    created_at: m.created_at,
  };
}

export async function detail(env: Env, m: Meme) {
  const album = await albumMemes(env.DB, m.id);
  return {
    ...(await brief(env, m)),
    caption: m.caption,
    source: m.source,
    description: m.description,
    ocr_text: m.ocr_text,
    speech_text: m.speech_text,
    meme_context: m.meme_context,
    cultural_meaning: m.cultural_meaning,
    file: fileFits(m) ? `${base(env)}/app/file/${m.id}${await signedQuery(env, `file|${m.id}`, URL_TTL)}` : null,
    album: album.length > 1 ? await Promise.all(album.map((a) => brief(env, a))) : [],
  };
}

/** Download name of a meme file: its title (or id) and the extension of its type. */
const fileName = (m: Meme) =>
  `${(m.title ?? "").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60) || m.id}.${extOf(m.mime ?? (m.kind === "photo" ? "image/jpeg" : "video/mp4"))}`;

/** The user's memes among `ids` (max 100). */
export async function ownMemes(env: Env, userId: number, ids: string[]) {
  ids = ids.filter((id) => typeof id === "string").slice(0, 100);
  if (!ids.length) return [];
  const q = ids.map(() => "?").join(",");
  return (await env.DB.prepare(`SELECT * FROM memes WHERE user_id = ? AND id IN (${q})`).bind(userId, ...ids).all<Meme>()).results;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function listMemes(env: Env, user: User, url: URL) {
  const sort = { new: "created_at DESC", old: "created_at ASC", title: "title IS NULL, title COLLATE NOCASE" }[url.searchParams.get("sort") ?? "new"];
  const tag = url.searchParams.get("tag");
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const filters = filterSql(url);
  const where = ["user_id = ?", ...(tag ? ["instr(char(10) || tags || char(10), char(10) || ? || char(10)) > 0"] : []), ...filters.where];
  // Plain browsing shows an album as its first meme; a tag or filters show every matching meme.
  if (where.length === 1) where.push(`NOT EXISTS (SELECT 1 ${ALBUM_JOIN} AND j.position < i.position WHERE i.meme_id = memes.id)`);
  const { results } = await env.DB.prepare(`SELECT * FROM memes WHERE ${where.join(" AND ")} ORDER BY ${sort ?? "created_at DESC"} LIMIT ? OFFSET ?`)
    .bind(user.id, ...(tag ? [tag] : []), ...filters.params, PAGE + 1, offset)
    .all<Meme>();
  const page = results.slice(0, PAGE);
  const sizes = new Map(
    page.length
      ? (
          await env.DB.prepare(`SELECT i.meme_id AS id, COUNT(*) AS n ${ALBUM_JOIN} WHERE i.meme_id IN (${page.map(() => "?").join(",")}) GROUP BY i.meme_id`)
            .bind(...page.map((m) => m.id))
            .all<{ id: string; n: number }>()
        ).results.map((r) => [r.id, r.n])
      : [],
  );
  return {
    items: await Promise.all(page.map(async (m) => ({ ...(await brief(env, m)), album: (sizes.get(m.id) ?? 0) > 1 ? sizes.get(m.id) : undefined }))),
    next_offset: results.length > PAGE ? offset + PAGE : null,
  };
}

/** Joins a meme (i) to the other memes (f, at j) of its media group. */
const ALBUM_JOIN = `FROM post_items i JOIN posts p ON p.id = i.post_id AND p.media_group_id IS NOT NULL
  JOIN post_items j ON j.post_id = i.post_id JOIN memes f ON f.id = j.meme_id`;

export async function tagCounts(env: Env, user: User) {
  const { results } = await env.DB.prepare("SELECT tags FROM memes WHERE user_id = ? AND tags IS NOT NULL").bind(user.id).all<{ tags: string }>();
  const count = new Map<string, number>();
  for (const r of results) for (const tag of r.tags.split("\n")) if (tag) count.set(tag, (count.get(tag) ?? 0) + 1);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 300)
    .map(([tag, n]) => ({ tag, count: n }));
}

/** Mini App: `Authorization: tma <initData>`; scripts: `Bearer <API token>`; web: the session cookie from Telegram Login. */
async function authUser(req: Request, env: Env): Promise<{ user: User; token?: { write: boolean } } | null> {
  const header = req.headers.get("Authorization") ?? "";
  if (header.startsWith(`Bearer ${TOKEN_PREFIX}`)) {
    const t = await tokenUser(env.DB, header.slice(7));
    return t && { user: t.user, token: { write: t.write } };
  }
  if (header.startsWith("tma ")) {
    const from = await checkInitData(env.BOT_TOKEN, header.slice(4));
    const user = from && (await resolveUser(env, from))?.user;
    return user ? { user } : null;
  }
  const userId = await readSession(env, getCookie(req, "session"));
  const user = userId && (await getUser(env.DB, userId));
  return user ? { user } : null;
}

export const LIMITS: Record<Kind, number> = { photo: 10 << 20, video: 50 << 20, animation: 50 << 20 }; // Bot API send limits
export const kindOf = (mime: string): Kind | null =>
  mime === "image/gif" ? "animation" : mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : null;
const str = (v: File | string | null, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);
const num = (v: File | string | null) => (typeof v === "string" && v ? Math.round(Number(v)) || null : null);

/** POST /app/api/upload (multipart: file, thumb?, width?, height?, duration?, source?, album?, position?) — stored in R2 until the first send. */
async function upload(env: Env, user: User, req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "file required" }, 400);
  const album = str(form.get("album"), 100);
  const res = await saveUpload(env, user, file, {
    thumb: form.get("thumb"),
    width: num(form.get("width")),
    height: num(form.get("height")),
    duration: num(form.get("duration")),
    source: str(form.get("source"), 500),
    // One album per client id: the files of a carousel uploaded one by one, in position order.
    post: album ? { mediaGroupId: `api:${album}`, position: num(form.get("position")) ?? 0 } : undefined,
  });
  return "error" in res ? json({ error: res.error }, res.status) : json(res);
}

type UploadMeta = {
  thumb?: File | string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  source?: string | null;
  post?: { mediaGroupId: string; position: number };
};

/** Saves an uploaded file as a new meme (the app and MCP). */
export async function saveUpload(env: Env, user: User, file: File, meta: UploadMeta = {}) {
  const fail = (error: string, status: number) => ({ error, status });
  const kind = kindOf(file.type);
  if (!kind) return fail("only photos, videos and GIFs", 415);
  if (file.size > LIMITS[kind]) return fail("file too large", 413);

  const bytes = await file.arrayBuffer();
  const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const existing = await env.DB.prepare("SELECT id FROM memes WHERE user_id = ? AND sha256 = ?").bind(user.id, sha256).first<string>("id");
  if (existing) return { id: existing, duplicate: true };

  const base = `u/${user.id}/${sha256}`;
  const key = fileKey(base, file.type);
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: file.type } });
  const thumb = meta.thumb;
  const hasThumb = kind !== "photo" && thumb instanceof File && thumb.size > 0 && thumb.size < 1 << 20;
  if (hasThumb) await env.MEDIA.put(previewKey(base), await thumb.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });

  // Photos join an open batch import (/batch), like forwards in the bot.
  const importId = kind === "photo" ? await collectingImport(env.DB, user.id) : null;
  const id = await insertMeme(env.DB, user.id, {
    kind,
    file_id: "",
    file_unique_id: `r2:${sha256}`,
    preview_file_id: null,
    preview_unique_id: null,
    r2_file: key,
    r2_preview: hasThumb ? previewKey(base) : null,
    mime: file.type,
    file_size: file.size,
    width: meta.width ?? null,
    height: meta.height ?? null,
    duration: meta.duration ?? null,
    caption: null,
    source: meta.source ?? null,
    import_id: importId,
    sha256,
  });
  if (!id) return fail("already saved", 409);
  if (!importId || meta.post) await addToPost(env.DB, user.id, { memeId: id, ...meta.post });
  await env.JOBS.send({ type: "embed", memeId: id });
  return { id, duplicate: false, batched: importId !== null };
}

/** Signed download links (saved as attachments) for the user's memes among `ids`. */
export async function downloadLinks(env: Env, userId: number, ids: string[]) {
  const memes = (await ownMemes(env, userId, ids)).filter(fileFits);
  return Promise.all(
    memes.map(async (m) => {
      const name = fileName(m);
      return { id: m.id, name, url: `${base(env)}/app/file/${m.id}${await signedQuery(env, `file|${m.id}`, URL_TTL)}&dl=${encodeURIComponent(name)}` };
    }),
  );
}

/** Same as forwarding a failed meme again in the bot; false when the meme has not failed. */
export async function retryMeme(env: Env, meme: Meme) {
  if (meme.status !== "failed") return false;
  await env.DB.prepare("UPDATE memes SET status = 'embedding', error = NULL, updated_at = unixepoch() WHERE id = ?").bind(meme.id).run();
  await env.JOBS.send({ type: "embed", memeId: meme.id });
  return true;
}

/** /app/api/* — Mini App and web API. */
async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const auth = await authUser(req, env);
  if (!auth) return json({ error: "no access" }, 403);
  const { user, token } = auth;
  if (token && !token.write && req.method !== "GET") return json({ error: "read-only token" }, 403);

  const [, , , resource = "", id = "", action = ""] = url.pathname.split("/");
  if (resource === "me" && req.method === "GET") {
    return json({
      id: user.id,
      username: user.username,
      role: user.role,
      search_mode: user.search_mode,
      key: user.openrouter_key !== null,
      models: MODELS,
      describe_tier: user.describe_tier,
      billing: await billingStatus(env, user),
    });
  }
  // New AI work needs an active plan and credit (paid role); 402 tells the app to show the billing tab.
  const m = req.method;
  const aiWork =
    ((resource === "upload" || resource === "import") && m === "POST") ||
    (resource === "search" && url.searchParams.get("mode") !== "fts") ||
    (resource === "zip" && m === "POST" && !id) ||
    (resource === "batch" && m === "POST" && (id === "start" || id === "retry")) ||
    (action === "retry" && m === "POST");
  if (aiWork) {
    const gate = await canUseAi(env.DB, user);
    if (!gate.ok) return json({ error: "payment required", reason: gate.reason }, 402);
  }
  // API tokens cannot change the account (tokens, keys, billing, deletion).
  const account = token && m !== "GET" ? null : await handleAccount(req, env, user, [resource, id, action]);
  if (account) return account;
  if (resource === "upload" && req.method === "POST") return upload(env, user, req);
  if (resource === "import" && req.method === "POST") {
    // Media of a link (any cobalt service), saved in the background like a link sent to the bot.
    const { url: link = "" } = await req.json<{ url?: string }>();
    if (!/^https?:\/\/\S+$/i.test(link)) return json({ error: "url required" }, 400);
    await env.JOBS.send({ type: "link", userId: user.id, url: link });
    return json({ queued: true }, 202);
  }
  if (resource === "status" && req.method === "GET") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 50);
    if (!ids.length) return json([]);
    const { results } = await env.DB.prepare(
      `SELECT id, status, title FROM memes WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(user.id, ...ids)
      .all();
    return json(results);
  }
  if (resource === "memes" && !id && req.method === "GET") return json(await listMemes(env, user, url));
  if (resource === "delete" && req.method === "POST") {
    // Batch delete from the selection mode (the app sends up to 100 ids per call).
    const { ids = [] } = await req.json<{ ids?: string[] }>();
    const memes = await ownMemes(env, user.id, ids);
    await deleteMemes(env, memes.map((m) => m.id));
    return json({ deleted: memes.map((m) => m.id) });
  }
  if (resource === "files" && req.method === "GET") {
    // Batch download: signed links that the browser saves as attachments.
    return json(await downloadLinks(env, user.id, (url.searchParams.get("ids") ?? "").split(",")));
  }
  if (resource === "tags" && req.method === "GET") return json(await tagCounts(env, user));
  if (resource === "facets" && req.method === "GET") return json(await facets(env.DB, user.id));
  if (resource === "search" && req.method === "GET") {
    // fts: keyword only (instant); fast: hybrid + LLM query rewrite; advanced: the chat agent.
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
    const mode = url.searchParams.get("mode") ?? "fast";
    const memes =
      q.length < 2
        ? []
        : mode === "fts"
          ? await keywordSearch(env, user.id, q, PAGE)
          : mode === "advanced"
            ? await agentSearch(env, user.id, q)
            : await cachedFastSearch(env, user.id, q);
    return json({ items: await Promise.all(memes.map((m) => brief(env, m))), next_offset: null });
  }
  if (resource === "index" && req.method === "GET") {
    // Text of all memes for the client-side instant search.
    const { results } = await env.DB.prepare(
      `SELECT * FROM memes WHERE user_id = ? AND status != 'failed' ORDER BY created_at DESC`,
    )
      .bind(user.id)
      .all<Meme>();
    const items = await Promise.all(
      results.map(async (m) => ({
        ...(await brief(env, m)),
        ocr_text: m.ocr_text?.slice(0, 500) ?? "",
        phrases: m.search_phrases ?? "",
        caption: m.caption ?? "",
      })),
    );
    return json(items);
  }

  const meme = resource === "memes" && id ? await getMeme(env.DB, id) : null;
  if (!meme || meme.user_id !== user.id) return json({ error: "not found" }, 404);
  if (!action && req.method === "GET") return json(await detail(env, meme));
  if (!action && req.method === "DELETE") {
    await deleteMeme(env, meme.id);
    return json({ ok: true });
  }
  if (action === "retry" && req.method === "POST") {
    return (await retryMeme(env, meme)) ? json({ ok: true }) : json({ error: "not failed" }, 409);
  }
  const api = botApi(env.BOT_TOKEN);
  if (action === "share" && req.method === "POST") {
    // The Mini App opens Telegram's chat picker with WebApp.shareMessage(id).
    const result = await toInlineResult(env, meme);
    if (!result) return json({ error: "cannot share this meme yet" }, 409);
    const prepared = await api.savePreparedInlineMessage(user.id, result, {
      allow_user_chats: true,
      allow_bot_chats: true,
      allow_group_chats: true,
      allow_channel_chats: true,
    });
    return json({ id: prepared.id });
  }
  if (action === "send" && req.method === "POST") {
    await sendMeme(env, api, user.id, meme);
    return json({ ok: true });
  }
  if (action === "send_album" && req.method === "POST") {
    const album = await albumMemes(env.DB, meme.id);
    await sendAlbum(env, api, user.id, album.length ? album : [meme]);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

/** /app/thumb/<id> and /app/file/<id> — media for <img>/<video>, authorized by a signed query. */
async function handleMedia(req: Request, env: Env, ctx: ExecutionContext, url: URL, kind: "thumb" | "file"): Promise<Response> {
  const id = url.pathname.split("/")[3] ?? "";
  if (!(await verifyQuery(env, `${kind}|${id}`, url))) return new Response("Not found", { status: 404 });
  return cachedMedia(req, ctx, async () => {
    const meme = await getMeme(env.DB, id);
    if (!meme || (kind === "file" && !fileFits(meme))) return null;
    // Reading from R2 back-fills Telegram-only memes, so each file is downloaded from Telegram once.
    const media = await memeMedia(env, meme, kind === "thumb" ? "preview" : "file").catch(() => null);
    const dl = url.searchParams.get("dl"); // batch download: save as a file (the name is not signed, so it is encoded)
    const disposition: Record<string, string> = dl ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(dl)}` } : {};
    return media && new Response(media.bytes, { headers: { "Content-Type": media.mime, ...disposition } });
  });
}

export async function handleApp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname === "/app" || url.pathname === "/app/") return Response.redirect(`${base(env)}/`, 301); // old Mini App URL
  if (req.method === "GET" && url.pathname === "/app/api/openapi.json") return serveOpenapi(env);
  if (url.pathname.startsWith("/app/api/")) return handleApi(req, env, url);
  if (req.method === "GET" && url.pathname.startsWith("/app/thumb/")) return handleMedia(req, env, ctx, url, "thumb");
  if (req.method === "GET" && url.pathname.startsWith("/app/file/")) return handleMedia(req, env, ctx, url, "file");
  return null;
}
