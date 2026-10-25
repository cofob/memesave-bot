import { getUser } from "./db";

// Personal API tokens: "msv_<random>"; only the SHA-256 is stored.

export const TOKEN_PREFIX = "msv_";
const TOKENS_MAX = 20;

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A new token (returned once), or null when the user has too many. */
export async function createToken(db: D1Database, userId: number, name: string, write: boolean) {
  const n = await db.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?").bind(userId).first<number>("n");
  if ((n ?? 0) >= TOKENS_MAX) return null;
  const token = TOKEN_PREFIX + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_");
  const id = crypto.randomUUID().replaceAll("-", "");
  await db
    .prepare("INSERT INTO api_tokens (id, user_id, name, hash, write) VALUES (?, ?, ?, ?, ?)")
    .bind(id, userId, name.slice(0, 64) || "API", await sha256(token), write ? 1 : 0)
    .run();
  return { id, token };
}

export const listTokens = async (db: D1Database, userId: number) =>
  (
    await db
      .prepare("SELECT id, name, write, created_at, used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC")
      .bind(userId)
      .all<{ id: string; name: string; write: number; created_at: number; used_at: number | null }>()
  ).results.map((t) => ({ ...t, write: !!t.write }));

export const deleteToken = async (db: D1Database, userId: number, id: string) =>
  !!(await db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ? RETURNING id").bind(id, userId).first());

/** The user and access of a token. */
export async function tokenUser(db: D1Database, token: string) {
  const row = await db
    .prepare("UPDATE api_tokens SET used_at = unixepoch() WHERE hash = ? RETURNING user_id, write")
    .bind(await sha256(token))
    .first<{ user_id: number; write: number }>();
  const user = row && (await getUser(db, row.user_id));
  return user ? { user, write: !!row.write } : null;
}
