import { ALBUM_FIRST, type Meme } from "./db";

export const FEED_MODES = ["new", "old", "random", "favorites", "forgotten", "day", "unseen"] as const;
export type FeedMode = (typeof FEED_MODES)[number];
/**
 * tz: minutes east of UTC (the "day" mode). seed: the order of the "random" mode (1…2147483646); for "unseen", the start
 * of the feed session (unix time): memes first seen after it stay, so the offsets of the session do not shift.
 */
export interface FeedQuery { mode: FeedMode; seed: number; offset: number; limit: number; tz: number }
export type FeedMeme = Meme & { uses: number; date: number };

/** When the user saved it at the source (e.g. the TikTok like), else when it came here. */
const DATE = "COALESCE(saved_at, created_at)";
const USES = "(SELECT COUNT(*) FROM meme_uses u WHERE u.user_id = memes.user_id AND u.meme_id = memes.id)";
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
    case "day": {
      // Same day of the month in earlier months and years ("a month ago", "a year ago"), in the user's time zone.
      const tz = q.tz * 60;
      const now = Math.floor(Date.now() / 1000) + tz;
      const day = String(new Date(now * 1000).getUTCDate()).padStart(2, "0");
      return { where: `strftime('%d', ${DATE} + ?, 'unixepoch') = ? AND ${DATE} < ?`, params: [tz, day, now - (now % 86400) - tz], order: `${DATE} DESC` };
    }
    case "unseen":
      return {
        where: "NOT EXISTS (SELECT 1 FROM meme_views v WHERE v.user_id = memes.user_id AND v.meme_id = memes.id AND v.seen_at < ?)",
        params: [q.seed],
        order: `${DATE} DESC`,
      };
  }
}

export const feedMode = (s: string | null | undefined): FeedMode | null => (FEED_MODES.includes(s as FeedMode) ? (s as FeedMode) : null);
/** The seed of a new feed session in a mode. */
export const startSeed = (mode: FeedMode) => (mode === "random" ? 1 + Math.floor(Math.random() * (PRIME - 1)) : mode === "unseen" ? Math.floor(Date.now() / 1000) : 1);

/** One page of the user's feed; an album shows as its first meme. */
export async function feedPage(db: D1Database, userId: number, q: FeedQuery) {
  const m = mode(q);
  const where = ["user_id = ?", "status != 'failed'", ALBUM_FIRST, ...(m.where ? [m.where] : [])];
  const { results } = await db
    .prepare(`SELECT *, ${USES} AS uses, ${DATE} AS date FROM memes WHERE ${where.join(" AND ")} ORDER BY ${m.order} LIMIT ? OFFSET ?`)
    .bind(userId, ...(m.params ?? []), ...(m.orderParams ?? []), q.limit + 1, q.offset)
    .all<FeedMeme>();
  return { memes: results.slice(0, q.limit), more: results.length > q.limit };
}

/** Marks the user's own memes among `ids` (max 100) as seen. */
export async function markSeen(db: D1Database, userId: number, ids: string[]) {
  ids = ids.filter((id) => typeof id === "string").slice(0, 100);
  if (!ids.length) return;
  await db
    .prepare(
      `INSERT INTO meme_views (user_id, meme_id) SELECT user_id, id FROM memes WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})
       ON CONFLICT DO UPDATE SET views = views + 1`,
    )
    .bind(userId, ...ids)
    .run();
}
