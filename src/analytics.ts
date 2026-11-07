import type { User } from "./db";
import type { Env } from "./env";
import { allStats } from "./stats";

const DAY = "date(created_at, 'unixepoch')";
const MONTH = "strftime('%Y-%m', created_at, 'unixepoch')";

const SIZE = `CASE WHEN file_size < 102400 THEN '<100K' WHEN file_size < 512000 THEN '<500K' WHEN file_size < 1048576 THEN '<1M'
  WHEN file_size < 5242880 THEN '<5M' WHEN file_size < 20971520 THEN '<20M' ELSE '20M+' END`;
const DURATION = `CASE WHEN duration < 5 THEN '<5s' WHEN duration < 15 THEN '<15s' WHEN duration < 30 THEN '<30s'
  WHEN duration < 60 THEN '<1m' WHEN duration < 180 THEN '<3m' ELSE '3m+' END`;
const ASPECT = `CASE WHEN width * 1.0 / height < 0.8 THEN 'portrait' WHEN width * 1.0 / height < 1.25 THEN 'square'
  WHEN width * 1.0 / height < 2 THEN 'landscape' ELSE 'wide' END`;

/** Tag counts, tags per meme, co-occurrence of the top tags and monthly trends of the top tags. */
export function tagStats(rows: { tags: string; month: string }[]) {
  const count = new Map<string, number>();
  const perMeme = new Map<number, number>();
  const lists = rows.map((r) => ({ month: r.month, tags: [...new Set(r.tags.split("\n").filter(Boolean))] }));
  for (const { tags } of lists) {
    perMeme.set(tags.length, (perMeme.get(tags.length) ?? 0) + 1);
    for (const tag of tags) count.set(tag, (count.get(tag) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300);
  const coTags = top.slice(0, 30).map(([t]) => t);
  const trendTags = top.slice(0, 8).map(([t]) => t);
  const cooc = coTags.map(() => coTags.map(() => 0));
  const trend = new Map<string, Record<string, number>>();
  for (const { month, tags } of lists) {
    const set = new Set(tags);
    coTags.forEach((a, i) => set.has(a) && coTags.forEach((b, j) => i !== j && set.has(b) && cooc[i][j]++));
    const m = trend.get(month) ?? {};
    for (const t of trendTags) if (set.has(t)) m[t] = (m[t] ?? 0) + 1;
    trend.set(month, m);
  }
  return {
    top: top.map(([tag, n]) => ({ tag, count: n })),
    perMeme: [...perMeme.entries()].sort((a, b) => a[0] - b[0]).map(([tags, n]) => ({ tags, n })),
    cooc: { tags: coTags, matrix: cooc },
    trend: { tags: trendTags, months: [...trend.entries()].sort().map(([month, counts]) => ({ month, counts })) },
  };
}

const rows = <T = any>(r: D1Result) => r.results as T[];

type OriginKind = "channel" | "group" | "user" | "link" | "direct";

/** Where memes come from: forwarded from a channel, group or person, a link import, or sent directly. */
export function originStats(memes: { id: string; fwd: string | null; source: string | null; month: string }[], uses: Map<string, number>) {
  const kinds = new Map<OriginKind, number>();
  const named = new Map<string, { name: string; kind: OriginKind; n: number; uses: number }>();
  const months = new Map<string, Partial<Record<OriginKind, number>>>();
  for (const m of memes) {
    const kind: OriginKind =
      m.fwd === "channel" ? "channel" : m.fwd === "chat" ? "group" : m.fwd ? "user" : /^https?:\/\//.test(m.source ?? "") ? "link" : "direct";
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    const month = months.get(m.month) ?? {};
    month[kind] = (month[kind] ?? 0) + 1;
    months.set(m.month, month);
    if (kind === "direct") continue;
    // A channel source carries its post link; a link import is grouped by site.
    const name = kind === "link" ? hostOf(m.source!) : (m.source ?? "").replace(/\s*\(https?:\/\/[^)]*\)$/, "") || "—";
    const key = `${kind}:${name}`;
    const o = named.get(key) ?? { name, kind, n: 0, uses: 0 };
    o.n++;
    o.uses += uses.get(m.id) ?? 0;
    named.set(key, o);
  }
  return {
    kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, n]) => ({ kind, n })),
    top: [...named.values()].sort((a, b) => b.n - a.n).slice(0, 20),
    months: [...months.entries()].sort().map(([month, counts]) => ({ month, counts })),
  };
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^(www|m|vm|vt)\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

/** Charts of one user's collection and AI spend (the app's analytics mode). */
export async function userAnalytics(env: Env, user: User) {
  const q = (sql: string) => env.DB.prepare(sql).bind(user.id);
  const group = (expr: string, extra = "") =>
    q(`SELECT ${expr} AS k, COUNT(*) AS n FROM memes WHERE user_id = ? ${extra} GROUP BY k ORDER BY n DESC LIMIT 20`);
  const res = await env.DB.batch([
    q(`SELECT ${DAY} AS day, kind, COUNT(*) AS n FROM memes WHERE user_id = ? GROUP BY day, kind ORDER BY day`),
    q(`SELECT date(saved_at, 'unixepoch') AS day, COUNT(*) AS n FROM memes WHERE user_id = ? AND saved_at IS NOT NULL GROUP BY day ORDER BY day`),
    q("SELECT CAST(strftime('%w', created_at, 'unixepoch') AS INTEGER) AS wd, CAST(strftime('%H', created_at, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS n FROM memes WHERE user_id = ? GROUP BY wd, h"),
    group("kind"),
    group("status"),
    group("language", "AND language IS NOT NULL"),
    group(SIZE, "AND file_size IS NOT NULL"),
    group(DURATION, "AND duration IS NOT NULL AND kind != 'photo'"),
    group(ASPECT, "AND width > 0 AND height > 0"),
    q(`SELECT tags, ${MONTH} AS month FROM memes WHERE user_id = ? AND tags IS NOT NULL`),
    q(`SELECT ${DAY} AS day, kind, SUM(cost) AS cost FROM transactions WHERE user_id = ? GROUP BY day, kind ORDER BY day`),
    q(`SELECT model, SUM(cost) AS cost, COUNT(*) AS n, COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion
       FROM transactions WHERE user_id = ? GROUP BY model ORDER BY cost DESC`),
    q("SELECT key_source AS k, SUM(cost) AS cost FROM transactions WHERE user_id = ? GROUP BY k"),
    q("SELECT COALESCE(SUM(from_allowance), 0) AS allowance, COALESCE(SUM(from_balance), 0) AS balance, COALESCE(SUM(cost), 0) AS total FROM transactions WHERE user_id = ?"),
    q(`SELECT kind, SUM(cost) / COUNT(DISTINCT meme_id) AS per_meme FROM transactions WHERE user_id = ? AND meme_id IS NOT NULL GROUP BY kind ORDER BY per_meme DESC`),
    q(`SELECT size, COUNT(*) AS n FROM (SELECT COUNT(*) AS size FROM post_items i JOIN posts p ON p.id = i.post_id WHERE p.user_id = ? GROUP BY i.post_id HAVING size > 1)
       GROUP BY size ORDER BY size`), // albums only: a single meme is not one
    q(`SELECT id, json_extract(tg_meta, '$.forward_origin.type') AS fwd, source, ${MONTH} AS month FROM memes WHERE user_id = ?`),
    q("SELECT meme_id AS id, COUNT(*) AS n FROM meme_uses WHERE user_id = ? GROUP BY meme_id"),
    q(`SELECT ${DAY} AS day, via, COUNT(*) AS n FROM meme_uses WHERE user_id = ? GROUP BY day, via ORDER BY day`),
    q(`SELECT u.meme_id AS id, m.title, COUNT(*) AS n, MAX(u.created_at) AS last FROM meme_uses u JOIN memes m ON m.id = u.meme_id
       WHERE u.user_id = ? GROUP BY u.meme_id ORDER BY n DESC, last DESC LIMIT 24`),
    // Forgotten: the oldest ready memes never used since tracking started.
    q(`SELECT id, title, created_at FROM memes m WHERE user_id = ? AND status = 'ready'
       AND NOT EXISTS (SELECT 1 FROM meme_uses u WHERE u.meme_id = m.id) ORDER BY created_at LIMIT 24`),
    q(`SELECT COUNT(*) AS ready, COALESCE(SUM(NOT EXISTS (SELECT 1 FROM meme_uses u WHERE u.meme_id = m.id)), 0) AS never,
       (SELECT MIN(created_at) FROM meme_uses WHERE user_id = ?1) AS since FROM memes m WHERE user_id = ?1 AND status = 'ready'`),
    // How memes were saved (bot, web, Mini App, API, MCP, zip); older ones from before the column are "unknown".
    q(`SELECT ${MONTH} AS month, COALESCE(added_via, 'unknown') AS via, COUNT(*) AS n FROM memes WHERE user_id = ? GROUP BY month, via ORDER BY month`),
  ]);
  const [
    timeline, saved, heatmap, kinds, statuses, languages, sizes, durations, aspect, tags, spendDays, models, keys, covered, perMeme, albums,
    origins, useCounts, useDays, favorites, forgotten, useTotals, addedVia,
  ] = res.map(rows);
  return {
    timeline,
    saved,
    heatmap,
    kinds,
    statuses,
    languages,
    sizes,
    durations,
    aspect,
    tags: tagStats(tags),
    spend: { days: spendDays, models, keys, covered: covered[0], perMeme },
    albums,
    origins: originStats(origins, new Map(useCounts.map((u) => [u.id, u.n]))),
    uses: {
      days: useDays as { day: string; via: string; n: number }[],
      favorites: favorites as { id: string; title: string | null; n: number; last: number }[],
      forgotten: forgotten as { id: string; title: string | null; created_at: number }[],
      ...(useTotals[0] as { ready: number; never: number; since: number | null }),
    },
    added: addedVia as { month: string; via: string; n: number }[],
  };
}

/** Charts over all users (admins). */
export async function adminAnalytics(env: Env) {
  const q = (sql: string) => env.DB.prepare(sql);
  const res = await env.DB.batch([
    q(`SELECT ${DAY} AS day, role, COUNT(*) AS n FROM users GROUP BY day, role ORDER BY day`),
    q(`SELECT ${DAY} AS day, kind, COUNT(*) AS n FROM memes GROUP BY day, kind ORDER BY day`),
    q("SELECT status AS k, COUNT(*) AS n FROM memes GROUP BY k ORDER BY n DESC"),
    q("SELECT substr(error, 1, 80) AS k, COUNT(*) AS n FROM memes WHERE error IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 20"),
    q(`SELECT ${DAY} AS day, model, SUM(cost) AS cost FROM transactions GROUP BY day, model ORDER BY day`),
    q("SELECT key_source AS k, SUM(cost) AS cost FROM transactions GROUP BY k"),
    q(`SELECT ${MONTH} AS month, method, SUM(usd) AS usd, COUNT(*) AS n FROM payments WHERE refunded = 0 GROUP BY month, method ORDER BY month`),
  ]);
  const [users, memes, statuses, errors, spend, keys, payments] = res.map(rows);
  return { users, memes, statuses, errors, spend, keys, payments, table: await allStats(env) };
}
