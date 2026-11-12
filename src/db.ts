import type { Lang } from "./i18n";
import { MAX_BYTES, MAX_MEMES } from "./config";

export type Role = "admin" | "user" | "paid";
export type Kind = "photo" | "video" | "animation";

export interface User {
  id: number;
  username: string | null;
  role: Role;
  lang: string | null;
  search_mode: "advanced" | "fast";
  total_cost: number;
  openrouter_key: string | null;
  describe_tier: "max" | "medium";
  plan: "monthly" | "yearly" | null;
  plan_byok: number;
  paid_until: number | null;
  allowance_until: number | null;
  plan_started: number | null;
  balance: number;
  sub_charge_id: string | null;
  sub_state: string | null;
  hide_porn: number; // 1: memes with the porn flag are hidden from search, the library and the feed
}

export interface Meme {
  id: string;
  user_id: number;
  kind: Kind;
  file_id: string;
  file_unique_id: string;
  preview_file_id: string | null;
  preview_unique_id: string | null;
  mime: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  caption: string | null;
  source: string | null;
  status: "embedding" | "describing" | "ready" | "failed";
  status_msg_id: number | null;
  title: string | null;
  description: string | null;
  ocr_text: string | null;
  speech_text: string | null;
  language: string | null;
  meme_context: string | null;
  cultural_meaning: string | null;
  tags: string | null;
  search_phrases: string | null;
  porn: number; // 1: sexual content in the picture or frames
  import_id: string | null;
  sha256: string | null;
  r2_file: string | null; // permanent copy in MEDIA ("" = cannot be downloaded from Telegram)
  r2_preview: string | null;
  tg_meta: string | null; // Telegram message JSON without media fields
  saved_at: number | null; // when the user saved it at the source (e.g. the TikTok like)
  share_id: string | null; // public short id of /s/ and /d/ links, set on the first share
  created_at: number;
}

export const userLang = async (db: D1Database, id: number): Promise<Lang> =>
  (await db.prepare("SELECT lang FROM users WHERE id = ?").bind(id).first<string>("lang")) === "ru" ? "ru" : "en";

export const getUser = (db: D1Database, id: number) =>
  db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();

/** True when the user cannot save `size` more bytes (MAX_MEMES / MAX_BYTES). */
export const storageFull = async (db: D1Database, userId: number, size = 0) =>
  !!(await db
    .prepare("SELECT COUNT(*) >= ? OR COALESCE(SUM(file_size), 0) + ? > ? AS f FROM memes WHERE user_id = ?")
    .bind(MAX_MEMES, size, MAX_BYTES, userId)
    .first<number>("f"));

export const getMeme = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM memes WHERE id = ?").bind(id).first<Meme>();

export const setStatus = (db: D1Database, id: string, status: Meme["status"], error: string | null = null) =>
  db.prepare("UPDATE memes SET status = ?, error = ?, updated_at = unixepoch() WHERE id = ?").bind(status, error, id).run();

/** Loads memes by id, keeping the order of `ids`. */
export async function loadMemes(db: D1Database, ids: string[]): Promise<Meme[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare(`SELECT * FROM memes WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<Meme>();
  const byId = new Map(results.map((m) => [m.id, m]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export const recentMemes = async (db: D1Database, userId: number, limit: number) =>
  (
    await db
      .prepare("SELECT * FROM memes WHERE user_id = ? AND status != 'failed' ORDER BY created_at DESC LIMIT ?")
      .bind(userId, limit)
      .all<Meme>()
  ).results;

/** Search results by the porn filter ("yes", "no"); without it, no porn memes when the user's setting hides them. */
export function visible<M extends Pick<Meme, "porn">>(user: Pick<User, "hide_porn">, memes: M[], porn: string[] = []) {
  const allow = porn.length ? porn : user.hide_porn ? ["no"] : ["yes", "no"];
  return memes.filter((m) => allow.includes(m.porn ? "yes" : "no"));
}

/** Counts a use of the user's own meme (favorite and forgotten memes in analytics). */
export const recordUse = (db: D1Database, userId: number, memeId: string, via: "inline" | "share" | "send") =>
  db.prepare("INSERT INTO meme_uses (user_id, meme_id, via) SELECT ?, id, ? FROM memes WHERE id = ? AND user_id = ?").bind(userId, via, memeId, userId).run();

/** Joins a meme (i) to the other memes (f, at j) of its media group. */
const ALBUM_JOIN = `FROM post_items i JOIN posts p ON p.id = i.post_id AND p.media_group_id IS NOT NULL
  JOIN post_items j ON j.post_id = i.post_id JOIN memes f ON f.id = j.meme_id`;

/** WHERE part over `memes`: an album shows as its first meme. */
export const ALBUM_FIRST = `NOT EXISTS (SELECT 1 ${ALBUM_JOIN} AND j.position < i.position WHERE i.meme_id = memes.id)`;

/** Sizes of the albums among `ids` (memes not in an album are left out). */
export const albumSizes = async (db: D1Database, ids: string[]) =>
  new Map(
    ids.length
      ? (
          await db
            .prepare(`SELECT i.meme_id AS id, COUNT(*) AS n ${ALBUM_JOIN} WHERE i.meme_id IN (${ids.map(() => "?").join(",")}) GROUP BY i.meme_id`)
            .bind(...ids)
            .all<{ id: string; n: number }>()
        ).results.map((r) => [r.id, r.n] as const)
      : [],
  );

type MemeStores ={ DB: D1Database; VECTORS: Vectorize; MEDIA: R2Bucket };

/** Deletes memes with their vectors and R2 files (up to 100 ids: Vectorize and D1 bind limits). */
export async function deleteMemes(env: MemeStores, ids: string[]) {
  if (!ids.length) return;
  await env.VECTORS.deleteByIds(ids.flatMap((id) => [`${id}:i`, `${id}:t`]));
  const { results } = await env.DB.prepare(`DELETE FROM memes WHERE id IN (${ids.map(() => "?").join(",")}) RETURNING r2_file, r2_preview`)
    .bind(...ids)
    .all<{ r2_file: string | null; r2_preview: string | null }>();
  // Posts of these memes: an emptied post goes with its audio; a changed album needs a new clip.
  const { results: posts } = await env.DB.prepare(
    `DELETE FROM post_items WHERE meme_id IN (${ids.map(() => "?").join(",")}) RETURNING post_id`,
  ).bind(...ids).all<{ post_id: string }>();
  const postIds = [...new Set(posts.map((p) => p.post_id))];
  const { results: media } = postIds.length
    ? await env.DB.prepare(`SELECT id, audio_r2, clip_r2, NOT EXISTS (SELECT 1 FROM post_items WHERE post_id = posts.id) AS empty FROM posts WHERE id IN (${postIds.map(() => "?").join(",")}) AND (audio_r2 IS NOT NULL OR clip_r2 IS NOT NULL)`)
        .bind(...postIds)
        .all<{ id: string; audio_r2: string | null; clip_r2: string | null; empty: number }>()
    : { results: [] };
  for (const p of media) {
    if (p.empty) await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(p.id).run();
    else await env.DB.prepare("UPDATE posts SET clip_r2 = NULL, clip_file_id = NULL WHERE id = ?").bind(p.id).run();
  }
  await env.DB.prepare(`DELETE FROM meme_uses WHERE meme_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
  await env.DB.prepare(`DELETE FROM meme_views WHERE meme_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
  const keys = [...results.flatMap((r) => [r.r2_file, r.r2_preview]), ...media.flatMap((p) => [p.empty ? p.audio_r2 : null, p.clip_r2])].filter((k): k is string => !!k);
  if (keys.length) await env.MEDIA.delete(keys);
}

export const deleteMeme = (env: MemeStores, id: string) => deleteMemes(env, [id]);
