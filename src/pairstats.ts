import { ASPECT, DURATION, HEATMAP, MONTH, originStats, SAVED, tagStats } from "./analytics";
import type { Env } from "./env";

/** Queries of one side, in the order `side` reads them. */
function queries(db: D1Database, id: number) {
  const q = (sql: string) => db.prepare(sql).bind(id);
  const group = (expr: string, extra = "") => q(`SELECT ${expr} AS k, COUNT(*) AS n FROM memes WHERE user_id = ? ${extra} GROUP BY k ORDER BY n DESC LIMIT 20`);
  return [
    q("SELECT COUNT(*) AS n FROM memes WHERE user_id = ? AND status = 'ready'"),
    group("kind"),
    q(HEATMAP),
    q(`SELECT ${MONTH} AS month, COUNT(*) AS n FROM memes WHERE user_id = ? AND ${SAVED} >= unixepoch('now', 'start of month', '-23 months') GROUP BY month ORDER BY month`),
    group("language", "AND language IS NOT NULL"),
    group(DURATION, "AND duration IS NOT NULL AND kind != 'photo'"),
    group(ASPECT, "AND width > 0 AND height > 0"),
    q(`SELECT tags, ${MONTH} AS month FROM memes WHERE user_id = ? AND tags IS NOT NULL`),
    q(`SELECT id, json_extract(tg_meta, '$.forward_origin.type') AS fwd, source, ${MONTH} AS month FROM memes WHERE user_id = ?`),
  ];
}

function side(id: number, name: string | null, [ready, kinds, heatmap, months, languages, durations, aspect, tags, origins]: any[][]) {
  const top = tagStats(tags).top;
  return {
    view: { id, name, ready: ready[0].n as number, kinds, heatmap, months, languages, durations, aspect, tags: top.slice(0, 50) },
    top,
    tags: new Map(top.map((t) => [t.tag, t.count])),
    sources: originStats(origins, new Map()).top,
  };
}

const cell = (cells: { wd: number; h: number; n: number }[]) => {
  const v = new Array<number>(168).fill(0);
  for (const c of cells) v[c.wd * 24 + c.h] = c.n;
  return v;
};
const cosine = (x: number[], y: number[]) => {
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  const d = Math.sqrt(dot(x, x) * dot(y, y));
  return d ? dot(x, y) / d : 0;
};
const center = (v: number[]) => v.map((x) => x - v.reduce((s, y) => s + y, 0) / v.length);

/** SQL stats of two collections side by side (no spend): activity, tags, sources and exact twins. */
export async function pairStats(env: Env, me: number, partner: number) {
  const db = env.DB;
  const res = await db.batch<any>([
    ...queries(db, me),
    ...queries(db, partner),
    // The same file in both collections: by Telegram file id or by content hash (two index joins), once per own meme.
    db
      .prepare(
        `SELECT x, y, xd, MIN(yd) AS yd FROM (
           SELECT x.id AS x, y.id AS y, COALESCE(x.saved_at, x.created_at) AS xd, COALESCE(y.saved_at, y.created_at) AS yd FROM memes x
           JOIN memes y ON y.user_id = ?2 AND y.file_unique_id = x.file_unique_id WHERE x.user_id = ?1 AND x.status != 'failed' AND y.status != 'failed'
           UNION
           SELECT x.id, y.id, COALESCE(x.saved_at, x.created_at), COALESCE(y.saved_at, y.created_at) FROM memes x
           JOIN memes y ON y.user_id = ?2 AND y.sha256 = x.sha256 WHERE x.user_id = ?1 AND x.status != 'failed' AND y.status != 'failed'
         ) GROUP BY x ORDER BY xd DESC`,
      )
      .bind(me, partner),
    db.prepare("SELECT IIF(a = ?1, a_name, b_name) AS me, IIF(a = ?1, b_name, a_name) AS partner FROM pairs WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)").bind(me, partner),
  ]);
  const r = res.map((x) => x.results);
  const n = r.length / 2 - 1;
  const names = r.at(-1)![0] ?? {};
  const [a, b] = [side(me, names.me ?? null, r.slice(0, n)), side(partner, names.partner ?? null, r.slice(n, 2 * n))];
  const twins = r.at(-2) as { x: string; y: string; xd: number; yd: number }[];

  let min = 0;
  let max = 0;
  for (const tag of new Set([...a.tags.keys(), ...b.tags.keys()])) {
    const [x, y] = [a.tags.get(tag) ?? 0, b.tags.get(tag) ?? 0];
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  const jaccard = max ? min / max : 0;
  const unique = (x: typeof a, y: typeof a) => x.top.filter((t) => !y.tags.has(t.tag)).slice(0, 10);
  const theirSources = new Map(b.sources.map((s) => [`${s.kind}:${s.name}`, s.n]));
  const months = [...new Set([...a.view.months, ...b.view.months].map((m) => m.month))].sort();
  const monthly = (s: typeof a) => months.map((m) => s.view.months.find((x) => x.month === m)?.n ?? 0);
  const hourSim = cosine(cell(a.view.heatmap), cell(b.view.heatmap));
  const twinShare = twins.length / Math.max(1, Math.min(a.view.ready, b.view.ready));
  return {
    me: a.view,
    partner: b.view,
    shared: {
      tags: a.top
        .filter((t) => b.tags.has(t.tag))
        .map((t) => ({ tag: t.tag, me: t.count, partner: b.tags.get(t.tag)! }))
        .sort((x, y) => Math.min(y.me, y.partner) - Math.min(x.me, x.partner))
        .slice(0, 30),
      jaccard,
      unique_me: unique(a, b),
      unique_partner: unique(b, a),
      sources: a.sources
        .filter((s) => theirSources.has(`${s.kind}:${s.name}`))
        .map((s) => ({ kind: s.kind, name: s.name, me: s.n, partner: theirSources.get(`${s.kind}:${s.name}`)! })),
      twins: {
        count: twins.length,
        items: twins.slice(0, 60).map((t) => [t.x, t.y, t.xd, t.yd] as [string, string, number, number]),
        first: { me: twins.filter((t) => t.xd < t.yd).length, partner: twins.filter((t) => t.yd < t.xd).length },
      },
      hourSim,
      monthSim: cosine(center(monthly(a)), center(monthly(b))), // Pearson correlation
    },
    // Preliminary (stage 1): tags, hours and twins (10% twins counts in full).
    compat: Math.round(100 * (0.5 * Math.sqrt(jaccard) + 0.3 * hourSim + 0.2 * Math.min(1, 10 * twinShare))),
  };
}
export type PairStats = Awaited<ReturnType<typeof pairStats>>;
