import type { User } from "./db";
import type { Env } from "./env";

const INGEST_KINDS = ["embed_image", "describe", "describe_batch", "embed_text"];

export interface UserStats {
  total: number;
  photo: number;
  video: number;
  animation: number;
  pending: number;
  failed: number;
  spend: number;
  global: number;
  own: number;
  spend30: number;
  avg: number;
  kinds: { kind: string; cost: number; count: number }[];
}

/** Memes and AI spend of one user (/stats and the app). */
export async function userStats(env: Env, user: User): Promise<UserStats> {
  const [counts, spend30, kinds, sources] = await env.DB.batch<any>([
    env.DB.prepare("SELECT kind, status, COUNT(*) AS n FROM memes WHERE user_id = ? GROUP BY kind, status").bind(user.id),
    env.DB.prepare("SELECT COALESCE(SUM(cost), 0) AS s FROM transactions WHERE user_id = ? AND created_at > unixepoch() - 30 * 86400").bind(
      user.id,
    ),
    env.DB.prepare("SELECT kind, SUM(cost) AS s, COUNT(*) AS n FROM transactions WHERE user_id = ? GROUP BY kind ORDER BY s DESC").bind(user.id),
    env.DB.prepare("SELECT key_source, SUM(cost) AS s FROM transactions WHERE user_id = ? GROUP BY key_source").bind(user.id),
  ]);
  const bySource = (src: string) => sources.results.find((r) => r.key_source === src)?.s ?? 0;
  const by = (f: (r: any) => boolean) => counts.results.filter(f).reduce((a, r) => a + r.n, 0);
  const ready = by((r) => r.status === "ready");
  const ingest = kinds.results.filter((k) => INGEST_KINDS.includes(k.kind)).reduce((a, k) => a + k.s, 0);
  return {
    total: by(() => true),
    photo: by((r) => r.kind === "photo"),
    video: by((r) => r.kind === "video"),
    animation: by((r) => r.kind === "animation"),
    pending: by((r) => r.status === "embedding" || r.status === "describing"),
    failed: by((r) => r.status === "failed"),
    spend: user.total_cost,
    global: bySource("global"),
    own: bySource("user"),
    spend30: spend30.results[0].s,
    avg: ready ? ingest / ready : 0,
    kinds: kinds.results.map((k) => ({ kind: k.kind, cost: k.s, count: k.n })),
  };
}

export interface AllStats {
  users: { id: number; username: string | null; memes: number; total_cost: number; global: number }[];
  total: number;
  global: number;
}

/** Spend of all users (/stats all, admins). */
export async function allStats(env: Env): Promise<AllStats> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.total_cost, (SELECT COUNT(*) FROM memes m WHERE m.user_id = u.id) AS memes,
      (SELECT COALESCE(SUM(cost), 0) FROM transactions x WHERE x.user_id = u.id AND x.key_source = 'global') AS global
     FROM users u ORDER BY u.total_cost DESC`,
  ).all<AllStats["users"][number]>();
  return {
    users: results,
    total: results.reduce((a, u) => a + u.total_cost, 0),
    global: results.reduce((a, u) => a + u.global, 0),
  };
}
