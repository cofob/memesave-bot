import { botApi } from "./botapi";
import type { User as TgUser } from "grammy/types";
import { resolveUser } from "./auth";
import { ALBUM_FIRST, albumSizes, visible, deleteMeme, deleteMemes, getMeme, getUser, recordUse, storageFull, type Kind, type Meme, type User } from "./db";
import { insertMeme, type AddedVia } from "./ingest/receive";
import { parseJson, saveDescription, toDescription, type Description, type SourceMeta } from "./ingest/describe";
import { collectingImport } from "./batch";
import { MODELS } from "./config";
import { handleAccount } from "./webaccount";
import { albumZip } from "./albumzip";
import { addToPost, albumMemes } from "./channels";
import { billingStatus, canUseAi, langOfUser } from "./billing";
import { facets, filterSql, list } from "./filters";
import { gallerySource, startGallery } from "./ingest/gallery";
import { chatVia } from "./ingest/link";
import { feedMode, feedPage, markSeen, type FeedMeme } from "./feed";
import { getCookie, readSession } from "./session";
import { TOKEN_PREFIX, tokenUser } from "./tokens";
import { serveOpenapi } from "./openapi";
import type { Env } from "./env";
import { cachedMedia, extOf, fileKey, memeMedia, previewKey, signedQuery, verifyQuery } from "./media";
import { sendAlbum, sendMeme, toInlineResult } from "./search/deliver";
import { agentSearch } from "./search/agent";
import { shareLinks } from "./share";
import { keywordSearch, regexSearch, validRegex } from "./search/hybrid";
import { cachedFastSearch } from "./search/inline";
import { esc, t } from "./i18n";
import { acceptPair, canView, createInvite, declinePair, endPair, getPair, listPairs, setShares } from "./pairs";
import { botName, inviteLink, pairAnswered, pairEnded, pickButton } from "./pairbot";
import { updateCard } from "./pairwidget";
import { pairStats } from "./pairstats";
import { analysisResult, analysisStatus, startPairAnalysis } from "./analysis";
import { handleShare, handleSharedAnalysis, revokeShares } from "./analysisshare";
import { editMeme, parseEdit } from "./ingest/edit";
import { attachAudio, audioError, audioPosts, ensureClip, postOf, sendClip, sendPostAudio } from "./audio";
import { handleLive } from "./live";
import { checkGuess, copyMeme, ownerOf, pairFeed, pairMode, pairPage } from "./pairfeed";

const PAGE = 60;
const FEED_PAGE = 10;
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
export const fileFits = (m: Meme) => !!m.r2_file || m.kind === "photo" || (m.file_size ?? Infinity) <= FILE_MAX;

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
    porn: !!m.porn,
    gif: m.mime === "image/gif" || undefined, // a GIF file (imported from a site) plays as an image, not a video
    created_at: m.created_at,
  };
}

const fileUrl = async (env: Env, m: Meme) =>
  fileFits(m) ? `${base(env)}/app/file/${m.id}${await signedQuery(env, `file|${m.id}`, URL_TTL)}` : null;

/** Signed URL of a post's audio; a new audio has a new key, so a new URL. */
const audioUrl = async (env: Env, p?: { id: string; audio_r2: string | null } | null) =>
  p?.audio_r2 ? `${base(env)}/app/audio/${p.id}${await signedQuery(env, `audio|${p.id}|${p.audio_r2}`, URL_TTL)}` : null;

/** A feed media: the brief with its file URL. */
const media = async (env: Env, m: Meme) => ({ ...(await brief(env, m)), file: await fileUrl(env, m) });

/** Feed API items: briefs with the file URL, uses, date, album size and memes, and audio. */
async function feedItems(env: Env, memes: FeedMeme[]) {
  const sizes = await albumSizes(env.DB, memes.map((m) => m.id));
  const audio = await audioPosts(env.DB, memes.map((m) => m.id));
  return Promise.all(
    memes.map(async (m) => {
      const album = (sizes.get(m.id) ?? 0) > 1 ? await albumMemes(env.DB, m.id) : [];
      return {
        ...(await media(env, m)),
        audio: await audioUrl(env, audio.get(m.id)),
        uses: m.uses,
        date: m.date,
        album: album.length ? sizes.get(m.id) : undefined,
        layout: album[0]?.album_layout ?? "carousel",
        slides: album.length ? await Promise.all(album.map((a) => media(env, a))) : undefined,
      };
    }),
  );
}

export async function detail(env: Env, row: Meme) {
  // Edits of an unfinished meme wait in `edits` until the AI step: show them already.
  const m: Meme = row.status !== "ready" && row.edits ? { ...row, ...JSON.parse(row.edits) } : row;
  const album = await albumMemes(env.DB, m.id);
  return {
    ...(await brief(env, m)),
    caption: m.caption,
    source: m.source,
    source_meta: m.source_meta ? JSON.parse(m.source_meta) : null,
    saved_at: m.saved_at,
    description: m.description,
    ocr_text: m.ocr_text,
    speech_text: m.speech_text,
    meme_context: m.meme_context,
    cultural_meaning: m.cultural_meaning,
    search_phrases: m.search_phrases ? m.search_phrases.split("\n") : [],
    file: await fileUrl(env, m),
    audio: await audioUrl(env, await postOf(env.DB, m.id)),
    album: album.length > 1 ? await Promise.all(album.map((a) => media(env, a))) : [],
    zip: album.length > 1 ? `${base(env)}/app/zip/${m.id}${await signedQuery(env, `zip|${m.id}`, URL_TTL)}` : null, // all files of the album
    layout: album[0]?.album_layout ?? "carousel",
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
  const sort = { new: "created_at DESC, id", old: "created_at ASC, id", title: "title IS NULL, title COLLATE NOCASE, id" }[url.searchParams.get("sort") ?? "new"];
  const tag = url.searchParams.get("tag");
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const filters = filterSql(url);
  const where = ["user_id = ?", ...(tag ? ["instr(char(10) || tags || char(10), char(10) || ? || char(10)) > 0"] : []), ...filters.where];
  // Plain browsing shows an album as its first meme; a tag or filters show every matching meme.
  if (where.length === 1) where.push(ALBUM_FIRST);
  if (user.hide_porn && !list(url, "porn").length) where.push("porn = 0"); // a porn filter overrides the setting
  const { results } = await env.DB.prepare(`SELECT * FROM memes WHERE ${where.join(" AND ")} ORDER BY ${sort ?? "created_at DESC"} LIMIT ? OFFSET ?`)
    .bind(user.id, ...(tag ? [tag] : []), ...filters.params, PAGE + 1, offset)
    .all<Meme>();
  const page = results.slice(0, PAGE);
  const sizes = await albumSizes(env.DB, page.map((m) => m.id));
  return {
    items: await Promise.all(page.map(async (m) => ({ ...(await brief(env, m)), album: (sizes.get(m.id) ?? 0) > 1 ? sizes.get(m.id) : undefined }))),
    next_offset: results.length > PAGE ? offset + PAGE : null,
  };
}

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
async function authUser(req: Request, env: Env): Promise<{ user: User; token?: { write: boolean }; via: AddedVia; name?: string } | null> {
  const header = req.headers.get("Authorization") ?? "";
  if (header.startsWith(`Bearer ${TOKEN_PREFIX}`)) {
    const t = await tokenUser(env.DB, header.slice(7));
    return t && { user: t.user, token: { write: t.write }, via: "api" };
  }
  if (header.startsWith("tma ")) {
    const from = await checkInitData(env.BOT_TOKEN, header.slice(4));
    const user = from && (await resolveUser(env, from))?.user;
    return user ? { user, via: "miniapp", name: from.first_name } : null;
  }
  const userId = await readSession(env, getCookie(req, "session"));
  const user = userId && (await getUser(env.DB, userId));
  return user ? { user, via: "web" } : null;
}

export const LIMITS: Record<Kind, number> = { photo: 10 << 20, video: 50 << 20, animation: 50 << 20 }; // Bot API send limits
export const kindOf = (mime: string): Kind | null =>
  mime === "image/gif" ? "animation" : mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : null;
const str = (v: File | string | null, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);
const num = (v: File | string | null) => (typeof v === "string" && v ? Math.round(Number(v)) || null : null);

/** POST /app/api/upload (multipart: file, thumb?, width?, height?, duration?, source?, saved_at?, caption?, album?, position?, description?, audio?) — stored in R2 until the first send. */
async function upload(env: Env, user: User, req: Request, via: AddedVia) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "file required" }, 400);
  const audio = form.get("audio");
  if (audio instanceof File && (kindOf(file.type) !== "photo" || audioError(audio))) return json({ error: audioError(audio) ?? "audio is only for photos" }, 415);
  const album = str(form.get("album"), 100);
  const raw = str(form.get("description"), 100_000);
  let description: Description | undefined;
  try {
    description = raw ? toDescription(parseJson(raw), raw) : undefined;
  } catch {
    return json({ error: "bad description" }, 400);
  }
  const res = await saveUpload(env, user, file, {
    thumb: form.get("thumb"),
    width: num(form.get("width")),
    height: num(form.get("height")),
    duration: num(form.get("duration")),
    source: str(form.get("source"), 500),
    saved_at: num(form.get("saved_at")),
    caption: str(form.get("caption"), 4096),
    // One album per client id: the files of a carousel uploaded one by one, in position order.
    post: album ? { mediaGroupId: `api:${album}`, position: num(form.get("position")) ?? 0 } : undefined,
    description,
    via,
  });
  if ("error" in res) return json({ error: res.error }, res.status);
  if (audio instanceof File) await attachAudio(env, (await getMeme(env.DB, res.id))!, audio); // one audio per album: send it with one file
  return json(res);
}

type UploadMeta = {
  via?: AddedVia;
  thumb?: File | string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  source?: string | null;
  saved_at?: number | null;
  caption?: string | null;
  post?: { mediaGroupId: string; position: number; layout?: "comic" };
  description?: Description; // ready description: the describe stage skips the AI call
  sourceMeta?: SourceMeta; // import source: tags, full data (memes.source_meta, up to 100 KB)
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
  if (existing) {
    if (meta.post) await addToPost(env.DB, user.id, { memeId: existing, ...meta.post }); // a saved file is still part of this album
    return { id: existing, duplicate: true };
  }
  if (await storageFull(env.DB, user.id, file.size)) return fail("storage full", 507);

  const base = `u/${user.id}/${sha256}`;
  const key = fileKey(base, file.type);
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: file.type } });
  const thumb = meta.thumb;
  const hasThumb = kind !== "photo" && thumb instanceof File && thumb.size > 0 && thumb.size < 1 << 20;
  if (hasThumb) await env.MEDIA.put(previewKey(base), await thumb.arrayBuffer(), { httpMetadata: { contentType: "image/jpeg" } });

  const sm = meta.sourceMeta && JSON.stringify(meta.sourceMeta);
  const source_meta = sm && sm.length > 100_000 ? JSON.stringify({ ...meta.sourceMeta, data: null }) : sm;

  // Photos join an open batch import (/batch), like forwards in the bot.
  const importId = kind === "photo" && !meta.description && meta.post?.layout !== "comic" ? await collectingImport(env.DB, user.id) : null;
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
    caption: meta.caption ?? null,
    source: meta.source ?? null,
    saved_at: meta.saved_at ?? null,
    import_id: importId,
    sha256,
    added_via: meta.via ?? null,
    source_meta,
  });
  if (!id) return fail("already saved", 409);
  if (!importId || meta.post) await addToPost(env.DB, user.id, { memeId: id, ...meta.post });
  if (meta.description) await saveDescription(env.DB, { id, gen: 0, source_meta }, meta.description, "embedding").run();
  await env.JOBS.send({ type: kind !== "photo" && !hasThumb ? "thumb" : "embed", memeId: id }); // a video without a preview gets one first
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
  await env.JOBS.send({ type: "embed", memeId: meme.id, gen: meme.gen });
  return true;
}

/** /app/api/pairs[/<id>[/accept|decline|share|stats]] (src/pairs.ts). */
async function pairsApi(req: Request, env: Env, user: User, name: string | null, via: AddedVia, id: string, action: string) {
  const m = req.method;
  const notFound = json({ error: "not found" }, 404);
  if (!id && m === "GET") return json({ pairs: await listPairs(env.DB, user.id), bot: await botName(env) });
  if (!id && m === "POST") {
    const p = await createInvite(env.DB, user.id, name);
    if (!p) return json({ error: "pair_limit" }, 400);
    const link = inviteLink(await botName(env), p.id);
    const lang = langOfUser(user);
    // The Mini App shares it with WebApp.shareMessage(prepared): Telegram shows its chat picker.
    const article = {
      type: "article" as const,
      id: p.id,
      title: t(lang, "pair_share_title"),
      input_message_content: { message_text: t(lang, "pair_share_text", { name: esc(name ?? "?") }), parse_mode: "HTML" as const },
      reply_markup: { inline_keyboard: [[{ text: t(lang, "pair_btn_open"), url: link }]] },
    };
    const prepared =
      via === "miniapp"
        ? await botApi(env.BOT_TOKEN)
            .savePreparedInlineMessage(user.id, article, { allow_user_chats: true, allow_group_chats: true })
            .then((r) => r.id, () => null)
        : null;
    return json({ id: p.id, link, prepared });
  }
  if (id === "pick" && m === "POST") {
    // Bot API 9.6: the Mini App opens Telegram's user picker with it; the choice comes to the bot as users_shared.
    const button = await (botApi(env.BOT_TOKEN).raw as any).savePreparedKeyboardButton({ user_id: user.id, button: pickButton(langOfUser(user)) }).catch(console.error);
    return button ? json({ id: button.id as string }) : json({ error: "telegram" }, 502);
  }
  const view = async () => {
    const p = await getPair(env.DB, user.id, id);
    return p ? json(p) : notFound;
  };
  // The same side effects as the bot: the inviter hears back, the cards, the analysis; the partner hears of the end.
  if (m === "DELETE" && !action) {
    const p = await endPair(env.DB, id, user.id);
    return p ? (await pairEnded(env, p, user.id), json({ ok: true })) : notFound;
  }
  if (m === "POST" && (action === "accept" || action === "decline")) {
    const ok = action === "accept";
    const p = ok ? await acceptPair(env.DB, id, user.id, name) : await declinePair(env.DB, id, user.id);
    if (!p) return notFound;
    await pairAnswered(env, p, ok, name ?? "?");
    return ok ? view() : json({ ok: true });
  }
  if (m === "POST" && action === "share") {
    const body = await req.json<{ on?: boolean }>().catch(() => null);
    if (!body) return json({ error: "bad body" }, 400);
    const p = await setShares(env.DB, id, user.id, !!body.on);
    if (p?.status === "active") await updateCard(env, p);
    return p ? view() : notFound;
  }
  if (m === "GET" && action === "stats") {
    const p = await getPair(env.DB, user.id, id);
    return p?.status === "active" ? json(await pairStats(env, user.id, p.partner.id!)) : json({ error: "no access" }, 403);
  }
  if (action === "feed" || action === "guess") {
    // feed[/seen], guess: the pair feed (src/pairfeed.ts); guess pages hide whose meme it is.
    const url = new URL(req.url);
    const sub = url.pathname.split("/")[6] ?? "";
    const f = await pairFeed(env, user.id, id, m === "GET");
    if (!f) return json({ error: "no access" }, 403);
    if (m === "GET" && action === "feed" && !sub) {
      const mode = pairMode(url.searchParams.get("mode"));
      if (!mode || !f.modes.includes(mode)) return json({ error: "bad mode" }, 400);
      const n = (k: string) => Math.trunc(Number(url.searchParams.get(k))) || 0;
      const offset = Math.max(0, n("offset"));
      const { memes, more } = await pairPage(env, f, mode, { seed: Math.max(1, n("seed")), offset, limit: FEED_PAGE, hidePorn: !!user.hide_porn });
      const items = await feedItems(env, memes);
      return json({ items: mode === "guess" ? items : items.map((x, i) => ({ ...x, owner: ownerOf(f, memes[i]) })), next_offset: more ? offset + FEED_PAGE : null, modes: f.modes });
    }
    const body = await req.json<{ ids?: string[]; id?: string; owner?: string }>().catch(() => ({}) as Record<string, never>);
    if (m === "POST" && action === "feed" && sub === "seen") {
      await markSeen(env.DB, user.id, Array.isArray(body.ids) ? body.ids : [], f.users);
      return json({ ok: true });
    }
    if (m === "POST" && action === "guess") {
      const answer = typeof body.id === "string" && (await checkGuess(env, f, body.id, String(body.owner)));
      return answer ? json(answer) : notFound;
    }
  }
  if (action === "analysis") {
    // analysis[/result]: the embedding analysis of the pair (src/analysis.ts), paid by whoever starts it.
    if ((await getPair(env.DB, user.id, id))?.status !== "active") return json({ error: "no access" }, 403);
    const sub = new URL(req.url).pathname.split("/")[6] ?? "";
    if (m === "GET" && sub === "result") return analysisResult(env, id);
    if (m === "POST" && sub === "share") return handleShare(req, env, id, user.id);
    if (m === "DELETE" && sub === "share") return (await revokeShares(env, "pair_id = ?", id), json({ ok: true }));
    if (m === "GET" && !sub) return json(await analysisStatus(env, id));
    if (m === "POST" && !sub) {
      const { llm = true } = await req.json<{ llm?: boolean }>().catch(() => ({ llm: true }));
      const gate = llm ? await canUseAi(env.DB, user) : { ok: true as const };
      if (!gate.ok) return json({ error: "payment required", reason: gate.reason }, 402);
      const run = await startPairAnalysis(env, id, user.id, { llm: !!llm });
      return run === "pair_too_small" ? json({ error: run }, 400) : run ? json(run) : json({ error: "no access" }, 403);
    }
  }
  return notFound;
}

/** /app/api/* — Mini App and web API. */
async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const auth = await authUser(req, env);
  if (!auth) return json({ error: "no access" }, 403);
  const { user, token, via } = auth;
  if (token && !token.write && req.method !== "GET") return json({ error: "read-only token" }, 403);

  const [, , , resource = "", id = "", action = ""] = url.pathname.split("/");
  // ?owner=<id>: read a partner's memes (src/pairs.ts) with the viewer's own settings; writes stay on the own account.
  const ownerId = url.searchParams.has("owner") ? Number(url.searchParams.get("owner")) : user.id;
  if (ownerId !== user.id && (token || req.method !== "GET" || !(await canView(env.DB, user.id, ownerId)))) return json({ error: "no access" }, 403);
  const owner: User = ownerId === user.id ? user : { ...user, id: ownerId };
  // Semantic and agent search spend AI on the collection owner: the partner's memes are searched by keywords only.
  const freeSearch = ["fts", "regex"].includes(url.searchParams.get("mode") ?? "");
  if (owner !== user && resource === "search" && !freeSearch) return json({ error: "owner_search_mode" }, 400);
  if (resource === "me" && req.method === "GET") {
    return json({
      id: user.id,
      username: user.username,
      role: user.role,
      search_mode: user.search_mode,
      key: user.openrouter_key !== null,
      models: MODELS,
      describe_tier: user.describe_tier,
      hide_porn: !!user.hide_porn,
      blur_porn: !!user.blur_porn,
      billing: await billingStatus(env, user),
    });
  }
  // New AI work needs an active plan and credit (paid role); 402 tells the app to show the billing tab.
  const m = req.method;
  const aiWork =
    ((resource === "upload" || resource === "import") && m === "POST") ||
    (resource === "search" && !freeSearch) ||
    (resource === "zip" && m === "POST" && !id) ||
    (resource === "e621" && m === "PUT") ||
    (resource === "batch" && m === "POST" && (id === "start" || id === "retry")) ||
    (action === "retry" && m === "POST");
  if (aiWork) {
    const gate = await canUseAi(env.DB, user);
    if (!gate.ok) return json({ error: "payment required", reason: gate.reason }, 402);
  }
  // API tokens cannot change the account (tokens, keys, billing, deletion).
  const account = token && m !== "GET" ? null : await handleAccount(req, env, user, [resource, id, action]);
  if (account) return account;
  if (resource === "pairs") return token ? json({ error: "no access" }, 403) : pairsApi(req, env, user, auth.name ?? user.username, via, id, action);
  if (resource === "upload" && req.method === "POST") return upload(env, user, req, via);
  if (resource === "import" && req.method === "POST") {
    // Media of a link (a gallery source, else any cobalt service), saved in the background like a link sent to the bot; the app gets its messages in the bot chat.
    const { url: link = "" } = await req.json<{ url?: string }>();
    if (!/^https?:\/\/\S+$/i.test(link)) return json({ error: "url required" }, 400);
    if (gallerySource(link)) await startGallery(env, user.id, link, via, chatVia(via) ? user.id : undefined);
    else await env.JOBS.send({ type: "link", userId: user.id, url: link, via });
    return json({ queued: true }, 202);
  }
  // A ticket for the push WebSocket (src/live.ts): browsers cannot send the Mini App header there.
  if (resource === "live" && m === "GET") return json({ url: `/app/live/${user.id}${await signedQuery(env, `live|${user.id}`, 60)}` });
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
  if (resource === "memes" && !id && req.method === "GET") {
    const ids = url.searchParams.get("ids"); // previews of known memes (e.g. a partner's twins)
    if (ids === null) return json(await listMemes(env, owner, url));
    return json({ items: await Promise.all(visible(user, await ownMemes(env, owner.id, ids.split(","))).map((m) => brief(env, m))), next_offset: null });
  }
  if (resource === "feed" && !id && req.method === "GET") {
    const mode = feedMode(url.searchParams.get("mode"));
    if (!mode) return json({ error: "bad mode" }, 400);
    const n = (k: string) => Math.trunc(Number(url.searchParams.get(k))) || 0;
    const offset = Math.max(0, n("offset"));
    const { memes, more } = await feedPage(env.DB, user.id, { mode, seed: Math.max(1, n("seed")), offset, limit: FEED_PAGE, newer: url.searchParams.get("newer") === "1", hidePorn: !!user.hide_porn });
    return json({ items: await feedItems(env, memes), next_offset: more ? offset + FEED_PAGE : null });
  }
  if (resource === "feed" && id === "seen" && req.method === "POST") {
    const { ids = [] } = await req.json<{ ids?: string[] }>();
    await markSeen(env.DB, user.id, Array.isArray(ids) ? ids : []);
    return json({ ok: true });
  }
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
  if (resource === "tags" && req.method === "GET") return json(await tagCounts(env, owner));
  if (resource === "facets" && req.method === "GET") return json(await facets(env.DB, owner.id));
  if (resource === "search" && req.method === "GET") {
    // fts: keyword only (instant); regex: JS regex over the text; fast: hybrid + LLM query rewrite; advanced: the chat agent.
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
    const mode = url.searchParams.get("mode") ?? "fast";
    if (mode === "regex" && !validRegex(q)) return json({ error: "bad regex" }, 400);
    const memes =
      q.length < 2
        ? []
        : mode === "regex"
          ? await regexSearch(env, owner.id, q, PAGE)
          : mode === "fts"
            ? await keywordSearch(env, owner.id, q, PAGE)
            : mode === "advanced"
              ? await agentSearch(env, user.id, q)
              : await cachedFastSearch(env, user.id, q);
    return json({ items: await Promise.all(visible(user, memes, list(url, "porn")).map((m) => brief(env, m))), next_offset: null });
  }
  if (resource === "index" && req.method === "GET") {
    // Text of all memes for the client-side instant search.
    const { results } = await env.DB.prepare(
      `SELECT * FROM memes WHERE user_id = ? AND status != 'failed' ORDER BY created_at DESC`,
    )
      .bind(owner.id)
      .all<Meme>();
    const items = await Promise.all(
      visible(user, results, list(url, "porn")).map(async (m) => ({
        ...(await brief(env, m)),
        ocr_text: m.ocr_text?.slice(0, 500) ?? "",
        phrases: m.search_phrases ?? "",
        caption: m.caption ?? "",
      })),
    );
    return json(items);
  }

  const meme = resource === "memes" && id ? await getMeme(env.DB, id) : null;
  // A partner's meme can be sent to the viewer's own chat (a file_id works for the whole bot) or copied to the own collection.
  const partner = !token && (action === "send" || action === "copy") && req.method === "POST" && !!meme && meme.user_id !== user.id && (await canView(env.DB, user.id, meme.user_id));
  if (meme && action === "copy" && req.method === "POST") {
    if (meme.user_id !== user.id && !partner) return json({ error: "no access" }, 403);
    const copy = await copyMeme(env, user.id, meme);
    return "error" in copy ? json({ error: copy.error }, copy.status) : json(copy);
  }
  if (!meme || (meme.user_id !== owner.id && !partner)) return json({ error: "not found" }, 404);
  if (!action && req.method === "GET") return json(await detail(env, meme));
  if (!action && req.method === "PATCH") {
    const patch = parseEdit(await req.json().catch(() => null));
    if (typeof patch === "string") return json({ error: patch }, 400);
    const res = await editMeme(env, meme, patch);
    return typeof res === "string" ? json({ error: res }, 409) : json(await detail(env, res));
  }
  if (!action && req.method === "DELETE") {
    await deleteMeme(env, meme.id);
    return json({ ok: true });
  }
  if (action === "delete_album" && req.method === "POST") {
    // The whole album (or the meme alone), 100 ids per call: the Vectorize and D1 bind limits.
    const ids = (await albumMemes(env.DB, meme.id)).filter((m) => m.user_id === meme.user_id).map((m) => m.id);
    if (!ids.length) ids.push(meme.id);
    for (let i = 0; i < ids.length; i += 100) await deleteMemes(env, ids.slice(i, i + 100));
    return json({ deleted: ids });
  }
  if (action === "retry" && req.method === "POST") {
    return (await retryMeme(env, meme)) ? json({ ok: true }) : json({ error: "not failed" }, 409);
  }
  if (action === "link" && req.method === "POST") return json(await shareLinks(env, meme));
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
    await recordUse(env.DB, user.id, meme.id, "share");
    return json({ id: prepared.id });
  }
  if (action === "send" && req.method === "POST") {
    await sendMeme(env, api, user.id, meme);
    await sendPostAudio(env, api, user.id, meme.id);
    if (!partner) await recordUse(env.DB, user.id, meme.id, "send");
    return json({ ok: true });
  }
  if (action === "send_album" && req.method === "POST") {
    const album = await albumMemes(env.DB, meme.id);
    await recordUse(env.DB, user.id, meme.id, "send");
    if (album.length > 10) {
      // flood control: the job sends it in parts
      await env.JOBS.send({ type: "send_album", userId: user.id, memeId: meme.id, from: 0 });
      return json({ ok: true, queued: true });
    }
    await sendAlbum(env, api, user.id, album.length ? album : [meme]);
    await sendPostAudio(env, api, user.id, meme.id);
    return json({ ok: true });
  }
  if (action === "send_clip" && req.method === "POST") {
    if (!(await sendClip(env, api, user.id, meme.id))) return json({ error: "no audio" }, 409);
    await recordUse(env.DB, user.id, meme.id, "send");
    return json({ ok: true });
  }
  if (action === "clip_link" && req.method === "POST") {
    const clip = await ensureClip(env, meme.id);
    if (!clip) return json({ error: "no audio" }, 409);
    const { id: postId, clip_r2 } = clip.post;
    return json({ url: `${base(env)}/app/clip/${postId}${await signedQuery(env, `clip|${postId}|${clip_r2}`, URL_TTL)}&dl=${encodeURIComponent(`${fileName(meme).replace(/\.[^.]+$/, "")}.mp4`)}` });
  }
  if (action === "audio" && (req.method === "POST" || req.method === "DELETE")) {
    const file = req.method === "POST" ? (await req.formData()).get("audio") : null;
    if (req.method === "POST" && !(file instanceof File)) return json({ error: "audio required" }, 400);
    const error = await attachAudio(env, meme, file as File | null);
    return error ? json({ error }, 415) : json({ audio: await audioUrl(env, await postOf(env.DB, meme.id)) });
  }
  if (action === "layout" && req.method === "POST") {
    const layout = ((await req.json().catch(() => null)) as { layout?: unknown } | null)?.layout;
    if (layout !== "carousel" && layout !== "comic") return json({ error: "layout must be carousel or comic" }, 400);
    await env.DB.prepare(
      "UPDATE posts SET layout = ? WHERE user_id = ? AND media_group_id IS NOT NULL AND id IN (SELECT post_id FROM post_items WHERE meme_id = ?)",
    )
      .bind(layout, meme.user_id, meme.id)
      .run();
    return json({ layout });
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

/** /app/zip/<id> — a .zip of all files of the meme's album, authorized by a signed query. */
async function handleZip(env: Env, url: URL): Promise<Response> {
  const id = url.pathname.split("/")[3] ?? "";
  const album = (await verifyQuery(env, `zip|${id}`, url)) ? await albumMemes(env.DB, id) : [];
  return album.length ? albumZip(env, album.filter(fileFits), album[0].title ?? id) : new Response("Not found", { status: 404 });
}

/** /app/audio/<postId> and /app/clip/<postId> — the post's audio or clip, authorized by a signed query over its current key. */
async function handlePostMedia(req: Request, env: Env, ctx: ExecutionContext, url: URL, col: "audio" | "clip"): Promise<Response> {
  const id = url.pathname.split("/")[3] ?? "";
  const key = await env.DB.prepare(`SELECT ${col}_r2 AS k FROM posts WHERE id = ?`).bind(id).first<string | null>("k");
  if (!key || !(await verifyQuery(env, `${col}|${id}|${key}`, url))) return new Response("Not found", { status: 404 });
  const dl = url.searchParams.get("dl");
  return cachedMedia(req, ctx, async () => {
    const obj = await env.MEDIA.get(key);
    const headers: Record<string, string> = { "Content-Type": obj?.httpMetadata?.contentType ?? (col === "clip" ? "video/mp4" : "audio/mpeg") };
    if (dl) headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(dl)}`;
    return obj && new Response(obj.body, { headers });
  });
}

export async function handleApp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname === "/app" || url.pathname === "/app/") return Response.redirect(`${base(env)}/`, 301); // old Mini App URL
  if (req.method === "GET" && url.pathname === "/app/api/openapi.json") return serveOpenapi(env);
  if (url.pathname.startsWith("/app/api/")) return handleApi(req, env, url);
  if (req.method === "GET" && url.pathname.startsWith("/app/shared/analysis/")) return handleSharedAnalysis(env, url.pathname.split("/")[4] ?? "");
  if (req.method === "GET" && url.pathname.startsWith("/app/thumb/")) return handleMedia(req, env, ctx, url, "thumb");
  if (req.method === "GET" && url.pathname.startsWith("/app/file/")) return handleMedia(req, env, ctx, url, "file");
  if (req.method === "GET" && url.pathname.startsWith("/app/zip/")) return handleZip(env, url);
  if (req.method === "GET" && url.pathname.startsWith("/app/live/")) return handleLive(req, env, url);
  if (req.method === "GET" && url.pathname.startsWith("/app/audio/")) return handlePostMedia(req, env, ctx, url, "audio");
  if (req.method === "GET" && url.pathname.startsWith("/app/clip/")) return handlePostMedia(req, env, ctx, url, "clip");
  return null;
}
