import type { User as TgUser } from "grammy/types";
import { DEFAULT_TIER } from "./config";
import { getUser, type Role, type User } from "./db";
import type { Env } from "./env";
import { langOf } from "./i18n";

/**
 * Finds the user for a Telegram account, or creates it: admin for the bootstrap admin,
 * the role of a pending username grant, otherwise "paid".
 */
export async function resolveUser(env: Env, from: TgUser): Promise<{ user: User; created: boolean } | null> {
  const db = env.DB;
  const username = from.username?.toLowerCase() ?? null;
  const lang = langOf(from);
  const user = await getUser(db, from.id);
  if (user) {
    if (user.username !== username || user.lang !== lang) {
      await db.prepare("UPDATE users SET username = ?, lang = ? WHERE id = ?").bind(username, lang, from.id).run();
    }
    return { user: { ...user, username, lang }, created: false };
  }

  let role: Role | null = String(from.id) === env.ADMIN_ID ? "admin" : null;
  let addedBy: number | null = null;
  if (!role && username) {
    const grant = await db
      .prepare("DELETE FROM grants WHERE username = ? RETURNING role, added_by")
      .bind(username)
      .first<{ role: Role; added_by: number }>();
    if (grant) [role, addedBy] = [grant.role, grant.added_by];
  }
  role ??= "paid"; // open signup: new accounts pay for the bot

  const created = await db
    .prepare("INSERT INTO users (id, username, role, lang, added_by, describe_tier) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(from.id, username, role, lang, addedBy, DEFAULT_TIER)
    .first<User>();
  return { user: created!, created: true };
}

export type Target = { id: number } | { username: string };

export function parseTarget(arg: string | undefined): Target | null {
  if (!arg) return null;
  if (/^\d+$/.test(arg)) return { id: Number(arg) };
  const username = arg.replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{4,32}$/.test(username) ? { username } : null;
}

/** Gives a role. Returns the user id when the account is known, or null for a pending username grant. */
export async function grant(db: D1Database, target: Target, role: Role, by: number): Promise<number | null> {
  if ("id" in target) {
    await db
      .prepare("INSERT INTO users (id, role, added_by, describe_tier) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET role = excluded.role")
      .bind(target.id, role, by, DEFAULT_TIER)
      .run();
    return target.id;
  }
  const user = await db
    .prepare("UPDATE users SET role = ? WHERE username = ? RETURNING id")
    .bind(role, target.username)
    .first<number>("id");
  if (user) return user;
  await db
    .prepare(
      "INSERT INTO grants (username, role, added_by) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET role = excluded.role, added_by = excluded.added_by",
    )
    .bind(target.username, role, by)
    .run();
  return null;
}

/** Removes access. Returns the removed user id (if any) and whether anything was removed. */
export async function revoke(db: D1Database, target: Target): Promise<{ id: number | null; removed: boolean }> {
  if ("id" in target) {
    const id = await db.prepare("DELETE FROM users WHERE id = ? RETURNING id").bind(target.id).first<number>("id");
    return { id, removed: id !== null };
  }
  const [users, grants] = await db.batch<{ id?: number }>([
    db.prepare("DELETE FROM users WHERE username = ? RETURNING id").bind(target.username),
    db.prepare("DELETE FROM grants WHERE username = ? RETURNING username").bind(target.username),
  ]);
  const id = users.results[0]?.id ?? null;
  return { id, removed: id !== null || grants.results.length > 0 };
}
