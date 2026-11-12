import { ALBUM_FIRST, type Meme } from "./db";

export const FEED_MODES = ["new", "old", "random", "favorites", "forgotten", "time", "unseen"] as const;
export type FeedMode = (typeof FEED_MODES)[number];
/**
 * seed: the order of the "random" mode (1…2147483646); for "unseen", the start of the feed session (unix time): memes
 * first seen after it stay, so the offsets of the session do not shift; for "time", the point in time the feed starts at.
 * newer: the "time" mode only: the memes after that point, oldest first (the feed above it); else the ones at or before it.
 */
export interface FeedQuery { mode: FeedMode; seed: number; offset: number; limit: number; newer?: boolean; hidePorn?: boolean }
export type FeedMeme = Meme & { uses: number; date: number };

/** When the user saved it at the source (e.g. the TikTok like), else when it came here. */
export const DATE = "COALESCE(saved_at, created_at)";
export const USES = "(SELECT COUNT(*) FROM meme_uses u WHERE u.user_id = memes.user_id AND u.meme_id = memes.id)";
const PRIME = 2147483647;

/** WHERE part (with its params) and ORDER BY of each mode. */
function mode(q: FeedQuery): { where?: string; params?: unknown[]; order: string; orderParams?: unknown[] } {
  switch (q.mode) {
    case "new":
      return { order: `${DATE} DESC` };
    case "old":
      return { order: `${DATE} ASC` };
    case "random": // multiplication modulo a prime: a stable permutation of the rowids, so pages do not repeat
      return { order: `(memes.rowid * ?) % ${PRIME}, memes.rowid`, orderParams: [q.seed] };
    case "favorites":
      return { where: `${USES} > 0`, order: `${USES} DESC, ${DATE} DESC` };
    case "forgotten":
      return { where: "NOT EXISTS (SELECT 1 FROM meme_uses u WHERE u.meme_id = memes.id)", order: `${DATE} ASC` };
    case "time": // a timeline from a point in time: down to older memes, up to newer ones
      return q.newer
        ? { where: `${DATE} > ?`, params: [q.seed], order: `${DATE} ASC, memes.rowid ASC` }
        : { where: `${DATE} <= ?`, params: [q.seed], order: `${DATE} DESC, memes.rowid DESC` };
    case "unseen":
      return {
        where: "NOT EXISTS (SELECT 1 FROM meme_views v WHERE v.user_id = memes.user_id AND v.meme_id = memes.id AND v.seen_at < ?)",
        params: [q.seed],
        order: `${DATE} DESC`,
      };
  }
}

export const feedMode = (s: string | null | undefined): FeedMode | null => (FEED_MODES.includes(s as FeedMode) ? (s as FeedMode) : null);
export const YEAR = 365 * 86400;
/** The seed of a new feed session in a mode ("time" starts a year ago). */
export function startSeed(mode: FeedMode) {
  const now = Math.floor(Date.now() / 1000);
  return mode === "random" ? 1 + Math.floor(Math.random() * (PRIME - 1)) : mode === "unseen" ? now : mode === "time" ? now - YEAR : 1;
}

/** One page of the feed of the user (or users); an album shows as its first meme. */
export async function feedPage(db: D1Database, userId: number | number[], q: FeedQuery) {
  const m = mode(q);
  const users = [userId].flat();
  const where = [`user_id IN (${users.map(() => "?").join(",")})`, "status != 'failed'", ALBUM_FIRST, ...(m.where ? [m.where] : []), ...(q.hidePorn ? ["porn = 0"] : [])];
  const { results } = await db
    .prepare(`SELECT *, ${USES} AS uses, ${DATE} AS date FROM memes WHERE ${where.join(" AND ")} ORDER BY ${m.order} LIMIT ? OFFSET ?`)
    .bind(...users, ...(m.params ?? []), ...(m.orderParams ?? []), q.limit + 1, q.offset)
    .all<FeedMeme>();
  return { memes: results.slice(0, q.limit), more: results.length > q.limit };
}

/** Marks the memes of `owners` (the user's own by default) among `ids` (max 100) as seen by the user. */
export async function markSeen(db: D1Database, userId: number, ids: string[], owners = [userId]) {
  ids = ids.filter((id) => typeof id === "string").slice(0, 90); // D1 binds at most 100 parameters
  if (!ids.length) return;
  await db
    .prepare(
      `INSERT INTO meme_views (user_id, meme_id) SELECT ?, id FROM memes WHERE user_id IN (${owners.map(() => "?").join(",")}) AND id IN (${ids.map(() => "?").join(",")})
       ON CONFLICT DO UPDATE SET views = views + 1`,
    )
    .bind(userId, ...owners, ...ids)
    .run();
}
