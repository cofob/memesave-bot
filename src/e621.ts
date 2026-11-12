import { canUseAi } from "./billing";
import { getUser, type User } from "./db";
import type { Env } from "./env";
import { saveItem, startGallery } from "./ingest/gallery";
import { linkSaved } from "./ingest/link";
import { basic, e621, e621Get, E621Error, mediaUrl, postItem, type Pool, type Post } from "./ingest/sources/e621";
import { decrypt, encrypt } from "./userkey";

// e621 account: favorites and upvoted posts are imported (backfill, then new ones by cron). A post in a
// series pool imports the whole pool once, as a comic.

const CHUNK = 10; // posts per job (downloads and D1 operations per invocation)
const PAGE = 320; // list page size (API maximum)
const PAUSED = ["payment required", "storage full"]; // the sync goes on by itself when the cause is gone
const DAY = 86400;

type List = "fav" | "vote";
export interface E621Job {
  userId: number;
  full?: boolean; // scan every page (backfill, daily rescan); else only the first page of each list
  list?: List; // quick scan: the list of this job
}
interface Account {
  username: string;
  api_key: string;
  fav_page: number;
  vote_before: number | null;
  error: string | null;
}

/** Checks the key, saves the account and starts the sync. A bad key throws E621Error (401/403). */
export async function connectE621(env: Env, userId: number, username: string, apiKey: string) {
  await e621Get(env, "/favorites.json?limit=1", basic(username, apiKey));
  const done = await env.DB.prepare(
    `INSERT INTO e621_accounts (user_id, username, api_key, last_sync) VALUES (?1, ?2, ?3, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET username = ?2, api_key = ?3, error = NULL, last_sync = unixepoch() RETURNING backfill_done`,
  )
    .bind(userId, username, await encrypt(env.ENCRYPTION_KEY, apiKey))
    .first<number>("backfill_done");
  await env.JOBS.send({ type: "e621_sync", userId, full: !done });
}

/** Removes the account and its bookkeeping; the memes stay. */
export const disconnectE621 = (db: D1Database, userId: number) =>
  db.batch(["e621_accounts", "e621_posts", "e621_pools"].map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId)));

export async function e621Status(db: D1Database, userId: number) {
  const acc = await db.prepare("SELECT username, backfill_done, last_sync, error FROM e621_accounts WHERE user_id = ?").bind(userId).first<{ username: string; backfill_done: number; last_sync: number; error: string | null }>();
  if (!acc) return { connected: false };
  const imported = await db.prepare("SELECT COUNT(*) AS n FROM e621_posts WHERE user_id = ?").bind(userId).first<number>("n");
  return { connected: true, ...acc, backfill_done: !!acc.backfill_done, imported };
}

/** Cron: a quick scan for new posts; a full rescan once a day (old posts can be upvoted later); a stalled scan restarts. */
export async function queueE621(env: Env) {
  await env.DB.prepare("UPDATE e621_accounts SET fav_page = 1, vote_before = NULL, backfill_done = 0, last_sync = 0 WHERE backfill_done = 1 AND scanned_at < unixepoch() - ?").bind(DAY).run();
  const { results } = await env.DB.prepare(
    `SELECT user_id, backfill_done FROM e621_accounts
     WHERE (error IS NULL OR error IN (${PAUSED.map(() => "?").join(",")})) AND (backfill_done = 1 OR last_sync < unixepoch() - 3600)`,
  )
    .bind(...PAUSED)
    .all<{ user_id: number; backfill_done: number }>();
  for (const r of results) await env.JOBS.send({ type: "e621_sync", userId: r.user_id, full: !r.backfill_done });
}

/** Ids of the posts that were handled before. */
async function handled(db: D1Database, userId: number, ids: number[]) {
  const { results } = await db.prepare("SELECT post_id FROM e621_posts WHERE user_id = ? AND post_id IN (SELECT value FROM json_each(?))").bind(userId, JSON.stringify(ids)).all<{ post_id: number }>();
  return new Set(results.map((r) => r.post_id));
}

/** The series pool of the post that is not imported yet. */
async function newSeries(env: Env, userId: number, p: Post, auth: string) {
  for (const id of p.pools) {
    if (await env.DB.prepare("SELECT 1 FROM e621_pools WHERE user_id = ? AND pool_id = ?").bind(userId, id).first()) continue;
    const pool = await e621Get<Pool>(env, `/pools/${id}.json`, auth);
    if (pool.category === "series") return pool;
  }
}

/** Imports one post, or its whole series pool. "full": the storage limit is reached. */
async function importPost(env: Env, user: User, p: Post, auth: string): Promise<"ok" | "full"> {
  const pool = await newSeries(env, user.id, p, auth);
  if (pool) {
    await startGallery(env, user.id, `https://e621.net/pools/${pool.id}`, "api");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO e621_pools (user_id, pool_id) VALUES (?, ?)").bind(user.id, pool.id),
      env.DB.prepare("INSERT OR REPLACE INTO e621_posts (user_id, post_id, pool_id) SELECT ?1, value, ?2 FROM json_each(?3)").bind(user.id, pool.id, JSON.stringify(pool.post_ids)),
    ]);
    return "ok";
  }
  const source = `https://e621.net/posts/${p.id}`;
  const media = mediaUrl(p);
  if (!media || (await linkSaved(env.DB, user.id, source))) return "ok";
  return (await saveItem(env, user, postItem(p, media), { src: e621, source, via: "api" })) === "full" ? "full" : "ok";
}

/**
 * Queue job: one list page and up to CHUNK new posts of it. Handled posts are marked, so the job repeats the
 * page until all are done, then moves on (full: the next page; quick: the next list). An auth error stops the sync.
 */
export async function e621Sync(env: Env, job: E621Job) {
  const { userId, full } = job;
  const db = env.DB;
  const acc = await db.prepare("SELECT * FROM e621_accounts WHERE user_id = ?").bind(userId).first<Account>();
  const user = acc && (await getUser(db, userId));
  if (!acc || !user || (acc.error && !PAUSED.includes(acc.error))) return;
  const stop = (error: string) => db.prepare("UPDATE e621_accounts SET error = ? WHERE user_id = ?").bind(error, userId).run();
  if (!(await canUseAi(db, user)).ok) return stop("payment required");
  await db.prepare("UPDATE e621_accounts SET error = NULL, last_sync = unixepoch() WHERE user_id = ?").bind(userId).run();

  const auth = basic(acc.username, await decrypt(env.ENCRYPTION_KEY, acc.api_key));
  const list = job.list ?? (full && !acc.fav_page ? "vote" : "fav");
  const page = !full || (list === "vote" && acc.vote_before === null) ? "1" : list === "fav" ? String(acc.fav_page) : `b${acc.vote_before}`;
  try {
    const query = new URLSearchParams({ ...(list === "vote" && { tags: `votedup:${acc.username}` }), limit: String(PAGE), page });
    const { posts } = await e621Get<{ posts: Post[] }>(env, `/${list === "fav" ? "favorites" : "posts"}.json?${query}`, auth);
    const seen = await handled(db, userId, posts.map((p) => p.id));
    const fresh = posts.filter((p) => !seen.has(p.id));
    for (const p of fresh.slice(0, CHUNK)) {
      try {
        if ((await importPost(env, user, p, auth)) === "full") return stop("storage full");
      } catch (e) {
        if (e instanceof E621Error && e.status !== 404) throw e;
        console.error("e621 post failed", p.id, e); // skipped
      }
      await db.prepare("INSERT OR IGNORE INTO e621_posts (user_id, post_id) VALUES (?, ?)").bind(userId, p.id).run();
    }
    if (fresh.length > CHUNK) return env.JOBS.send({ type: "e621_sync", ...job }); // the rest of the page

    if (!full) return list === "fav" ? env.JOBS.send({ type: "e621_sync", userId, list: "vote" }) : undefined;
    const fav = list === "fav" ? (posts.length ? acc.fav_page + 1 : 0) : acc.fav_page;
    const vote = list === "vote" ? (posts.length ? posts.at(-1)!.id : 0) : acc.vote_before;
    const done = !fav && vote === 0;
    await db.prepare("UPDATE e621_accounts SET fav_page = ?1, vote_before = ?2, backfill_done = ?3, scanned_at = IIF(?3, unixepoch(), scanned_at) WHERE user_id = ?4").bind(fav, vote, done ? 1 : 0, userId).run();
    if (!done) await env.JOBS.send({ type: "e621_sync", userId, full: true });
  } catch (e) {
    if (e instanceof E621Error && (e.status === 401 || e.status === 403)) return stop("unauthorized");
    throw e;
  }
}
