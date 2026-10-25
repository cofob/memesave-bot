import { botApi } from "./botapi";
import type { User } from "./db";
import type { Env } from "./env";
import { tmpKey } from "./media";
import { oauthApi } from "./oauth";

export const CONFIRM = "DELETE";
const CHUNK = 200;

/** Counts for the warning before the deletion. */
export async function accountSummary(db: D1Database, userId: number) {
  const [memes, payments] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM memes WHERE user_id = ?").bind(userId),
    db.prepare("SELECT COUNT(*) AS n FROM payments WHERE user_id = ?").bind(userId),
  ]);
  return { memes: memes.results[0].n, payments: payments.results[0].n };
}

/**
 * Deletes the account and all its rows at once. Memes are detached first (user_id = -id, status 'failed'),
 * so pipeline jobs stop and a returning user starts clean; the purge job then removes them with their
 * vectors and R2 files in the background.
 */
/** Revokes all MCP connections (OAuth grants) of the user. */
export async function revokeConnections(env: Env, userId: number) {
  const api = oauthApi(env);
  let cursor: string | undefined;
  do {
    const page = await api.listUserGrants(String(userId), { cursor });
    for (const g of page.items) await api.revokeGrant(g.id, String(userId));
    cursor = page.cursor;
  } while (cursor);
}

export async function deleteAccount(env: Env, user: User) {
  const db = env.DB;
  if (user.sub_charge_id && user.sub_state === "active") {
    await botApi(env.BOT_TOKEN).editUserStarSubscription(user.id, user.sub_charge_id, true).catch(console.error);
  }
  const [zips, exports] = await db.batch<{ id: string }>([
    db.prepare("SELECT id FROM zip_imports WHERE user_id = ?").bind(user.id),
    db.prepare("SELECT id FROM exports WHERE user_id = ?").bind(user.id),
  ]);
  const archives = [...zips.results.map((r) => tmpKey(`zip/${r.id}.zip`)), ...exports.results.map((r) => tmpKey(`export/${r.id}.zip`))];
  for (let i = 0; i < archives.length; i += 1000) await env.MEDIA.delete(archives.slice(i, i + 1000));
  const { results: channels } = await db.prepare("SELECT chat_id FROM channels WHERE user_id = ?").bind(user.id).all<{ chat_id: number }>();
  for (const ch of channels) await botApi(env.BOT_TOKEN).leaveChat(ch.chat_id).catch(() => {});
  await revokeConnections(env, user.id).catch(console.error);
  const tables = ["transactions", "imports", "zip_imports", "exports", "payments", "crypto_invoices", "notices", "oauth_states", "channels", "posts"];
  await db.batch([
    db.prepare("DELETE FROM post_items WHERE post_id IN (SELECT id FROM posts WHERE user_id = ?)").bind(user.id),
    db.prepare("UPDATE memes SET user_id = -user_id, status = 'failed', error = 'deleted', import_id = NULL WHERE user_id = ?").bind(user.id),
    ...tables.map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(user.id)),
    db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  await env.JOBS.send({ type: "purge", userId: user.id, before: Math.floor(Date.now() / 1000) });
}

/** R2 keys not used by the user's current memes (a returning user may have saved the same file again). */
async function unused(db: D1Database, userId: number, keys: string[]) {
  const kept = new Set<string>();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const q = chunk.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT r2_file, r2_preview FROM memes WHERE user_id = ? AND (r2_file IN (${q}) OR r2_preview IN (${q}))`)
      .bind(userId, ...chunk, ...chunk)
      .all<{ r2_file: string | null; r2_preview: string | null }>();
    results.forEach((u) => [u.r2_file, u.r2_preview].forEach((k) => k && kept.add(k)));
  }
  return keys.filter((k) => !kept.has(k));
}

/** Queue job: removes one chunk of detached memes, then the orphan R2 objects of the user. */
export async function purgeStage(env: Env, userId: number, before: number) {
  const db = env.DB;
  const { results } = await db
    .prepare("SELECT id, r2_file, r2_preview FROM memes WHERE user_id = ? LIMIT ?")
    .bind(-userId, CHUNK)
    .all<{ id: string; r2_file: string | null; r2_preview: string | null }>();
  if (results.length) {
    const ids = results.map((m) => m.id);
    await env.VECTORS.deleteByIds(ids.flatMap((id) => [`${id}:i`, `${id}:t`]));
    const drop = await unused(db, userId, results.flatMap((m) => [m.r2_file, m.r2_preview]).filter((k): k is string => !!k));
    if (drop.length) await env.MEDIA.delete(drop);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      await db.prepare(`DELETE FROM memes WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    }
    if (results.length === CHUNK) return env.JOBS.send({ type: "purge", userId, before });
  }
  // Objects without a meme row (e.g. zip blobs of a failed import); newer ones belong to the new account.
  let cursor: string | undefined;
  do {
    const list = await env.MEDIA.list({ prefix: `u/${userId}/`, cursor });
    const old = await unused(db, userId, list.objects.filter((o) => Math.floor(o.uploaded.getTime() / 1000) <= before).map((o) => o.key));
    if (old.length) await env.MEDIA.delete(old);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
