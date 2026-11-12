/** Two users who compare collections (migrations/0024_pairs.sql). */
export interface Pair {
  id: string;
  a: number;
  b: number | null;
  status: "pending" | "active";
  a_name: string | null;
  b_name: string | null;
  a_shares: number;
  b_shares: number;
  created_at: number;
  accepted_at: number | null;
  widget_id: string | null;
  widget_rev: string | null;
  quiz_id: string | null;
  compat: number | null;
}

const MAX_PAIRS = 20;
const INVITE_TTL = 7 * 86400;
// An invite that `?2` may accept: b, or anyone but a for an open link.
const OPEN = "status = 'pending' AND a != ?2 AND (b IS NULL OR b = ?2)";

/** An invite from `a` to `b` (an open link when b is null); the existing pair of a and b; null for self or over the limit. */
export async function createInvite(db: D1Database, a: number, aName: string | null, b: number | null = null, bName: string | null = null) {
  if (a === b) return null;
  // The pair of a and b, or (open link) the pending open invite of a.
  const old = await db.prepare("SELECT * FROM pairs WHERE (a = ?1 AND b IS ?2) OR (a = ?2 AND b = ?1)").bind(a, b).first<Pair>();
  if (old) return old;
  if ((await db.prepare("SELECT COUNT(*) AS n FROM pairs WHERE a = ?1 OR b = ?1").bind(a).first<number>("n"))! >= MAX_PAIRS) return null;
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(9))).toString("base64url");
  return db.prepare("INSERT INTO pairs (id, a, b, status, a_name, b_name) VALUES (?, ?, ?, 'pending', ?, ?) RETURNING *").bind(id, a, b, aName, bName).first<Pair>();
}

export const openInvite = (db: D1Database, id: string, userId: number) =>
  db.prepare(`SELECT * FROM pairs WHERE id = ?1 AND ${OPEN}`).bind(id, userId).first<Pair>();

/** Activates the invite; null when the user may not accept it (already in a pair with the inviter, or over the limit). */
export const acceptPair = (db: D1Database, id: string, userId: number, name: string | null) =>
  db
    .prepare(
      `UPDATE pairs SET b = ?2, b_name = ?3, status = 'active', accepted_at = unixepoch() WHERE id = ?1 AND ${OPEN}
       AND NOT EXISTS (SELECT 1 FROM pairs p WHERE p.id != ?1 AND ((p.a = pairs.a AND p.b = ?2) OR (p.a = ?2 AND p.b = pairs.a)))
       AND (SELECT COUNT(*) FROM pairs q WHERE q.id != ?1 AND (q.a = ?2 OR q.b = ?2)) < ${MAX_PAIRS} RETURNING *`,
    )
    .bind(id, userId, name)
    .first<Pair>();

/** Deletes the pair (end, or cancel an own invite) and its analyses when the user is in it; R2 lifecycle removes their files. */
export async function endPair(db: D1Database, id: string, userId: number) {
  const p = await db.prepare("DELETE FROM pairs WHERE id = ?1 AND (a = ?2 OR b = ?2) RETURNING *").bind(id, userId).first<Pair>();
  if (p) await db.batch([db.prepare("DELETE FROM analyses WHERE pair_id = ?").bind(id), db.prepare("DELETE FROM pair_quiz WHERE pair_id = ?").bind(id)]);
  return p;
}
/** The invited user says no to a pending invite. */
export const declinePair = (db: D1Database, id: string, userId: number) =>
  db.prepare("DELETE FROM pairs WHERE id = ?1 AND status = 'pending' AND b = ?2 RETURNING *").bind(id, userId).first<Pair>();

/** Shows (on) or hides the user's memes from the partner. */
export const setShares = (db: D1Database, id: string, userId: number, on: boolean) =>
  db
    .prepare("UPDATE pairs SET a_shares = IIF(a = ?2, ?3, a_shares), b_shares = IIF(b = ?2, ?3, b_shares) WHERE id = ?1 AND (a = ?2 OR b = ?2) RETURNING *")
    .bind(id, userId, on ? 1 : 0)
    .first<Pair>();

/** The pair as `me` sees it (the API's PairView). */
export function pairView(p: Pair & { username?: string | null }, me: number) {
  const mine = p.a === me;
  return {
    id: p.id,
    status: p.status,
    incoming: !mine && p.status === "pending",
    partner: { id: mine ? p.b : p.a, name: mine ? p.b_name : p.a_name, username: p.username ?? null },
    i_share: !!(mine ? p.a_shares : p.b_shares),
    they_share: !!(mine ? p.b_shares : p.a_shares),
    created_at: p.created_at,
    accepted_at: p.accepted_at,
  };
}
export type PairView = ReturnType<typeof pairView>;

const VIEW = "SELECT p.*, u.username FROM pairs p LEFT JOIN users u ON u.id = IIF(p.a = ?1, p.b, p.a) WHERE (p.a = ?1 OR p.b = ?1)";

export const listPairs = async (db: D1Database, userId: number) =>
  (await db.prepare(`${VIEW} ORDER BY p.created_at DESC`).bind(userId).all<Pair>()).results.map((p) => pairView(p, userId));

export async function getPair(db: D1Database, userId: number, id: string) {
  const p = await db.prepare(`${VIEW} AND p.id = ?2`).bind(userId, id).first<Pair>();
  return p && pairView(p, userId);
}

/**
 * True when `viewer` may read the memes of `owner`: an active pair where owner shares. Every read of another
 * user's memes checks it; signed /app/thumb|file URLs handed out before a revoke stay valid until their TTL.
 */
export const canView = async (db: D1Database, viewer: number, owner: number) =>
  !!(await db
    .prepare("SELECT 1 FROM pairs WHERE status = 'active' AND ((a = ?1 AND b = ?2 AND b_shares = 1) OR (a = ?2 AND b = ?1 AND a_shares = 1))")
    .bind(viewer, owner)
    .first());

/** Cron: invites nobody answered in a week. */
export const expireInvites = (db: D1Database) =>
  db.prepare("DELETE FROM pairs WHERE status = 'pending' AND created_at < unixepoch() - ?").bind(INVITE_TTL).run();
