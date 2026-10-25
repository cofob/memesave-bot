import { MIN_VECTOR_SCORE, RRF_K } from "../config";
import { loadMemes, type Meme } from "../db";
import type { Env } from "../env";
import { namespace } from "../ingest/embed";

/** Builds a safe FTS5 query: quoted prefix tokens joined with OR. */
export function ftsQuery(text: string): string | null {
  const tokens = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((x) => x.length >= 2);
  return tokens.length ? tokens.slice(0, 16).map((x) => `"${x}"*`).join(" OR ") : null;
}

/** Reciprocal Rank Fusion of ranked id lists. */
export function rrf(lists: string[][], k = RRF_K): string[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

async function vectorList(env: Env, userId: number, vector: number[]) {
  const { matches } = await env.VECTORS.query(vector, { topK: 50, namespace: namespace(userId), returnMetadata: "none" });
  return [...new Set(matches.filter((m) => m.score >= MIN_VECTOR_SCORE).map((m) => m.id.split(":")[0]))];
}

async function ftsList(db: D1Database, userId: number, text: string) {
  const q = ftsQuery(text);
  if (!q) return [];
  const { results } = await db
    .prepare(
      `SELECT m.id FROM memes_fts JOIN memes m ON m.rowid = memes_fts.rowid
       WHERE memes_fts MATCH ? AND m.user_id = ? ORDER BY bm25(memes_fts, 5, 4, 3, 3, 3, 1, 1, 1) LIMIT 50`,
    )
    .bind(q, userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Keyword-only search (D1 FTS5, bm25 order): fast and free, used for instant search in the app. */
export async function keywordSearch(env: Env, userId: number, text: string, limit: number): Promise<Meme[]> {
  return loadMemes(env.DB, (await ftsList(env.DB, userId, text)).slice(0, limit));
}

const safe = (p: Promise<string[]>) =>
  p.catch((e) => {
    console.warn("search source failed", e);
    return [];
  });

/** Vector + keyword search over one user's memes, merged by RRF. */
export async function hybridSearch(
  env: Env,
  userId: number,
  { vectors, texts, limit }: { vectors: number[][]; texts: string[]; limit: number },
): Promise<Meme[]> {
  const lists = await Promise.all([
    ...vectors.map((v) => safe(vectorList(env, userId, v))),
    ...texts.map((x) => safe(ftsList(env.DB, userId, x))),
  ]);
  return loadMemes(env.DB, rrf(lists).slice(0, limit));
}
