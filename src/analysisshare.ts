// Public links of analysis results: a sanitized permanent copy (no AI spend, sources or meme ids) at /?analysis=<sid>.
import { Buffer } from "node:buffer";
import { latest, READY, resultKey } from "./analysis";
import type { Env } from "./env";
import type { Pair } from "./pairs";
import { pairStats } from "./pairstats";

export const shareKey = (sid: string) => `share/analysis/${sid}.json`;
export const shareUrl = (env: Env, sid: string) => `${env.PUBLIC_URL.replace(/\/$/, "")}/?analysis=${sid}`;
const EMPTY_SPEND = { days: [], models: [], keys: [], covered: { allowance: 0, balance: 0, total: 0 }, perMeme: [] };

/** Removes the private parts of a result: spend, source names and the meme previews (meme ids of lists). */
export function sanitize(r: any) {
  const out = { ...r, clusters: (r.clusters ?? []).map((c: any) => ({ ...c, sample: [] })) };
  delete out.images;
  delete out.titles;
  if (r.owners) return { ...out, owners: [0, 1], twins: [], rhymes: [], for: [[], []], surprise: [[], []], bridge: [] };
  const a = r.analytics;
  return {
    ...out,
    duplicates: [],
    outliers: [],
    alignment: r.alignment && { ...r.alignment, worst: [] },
    analytics: a && {
      ...a,
      spend: EMPTY_SPEND,
      stats: a.stats && { ...a.stats, spend: 0, spend30: 0, avg: 0 },
      origins: { ...a.origins, top: [] },
      uses: { ...a.uses, favorites: [], forgotten: [] },
    },
  };
}

/** The link of the latest finished analysis of the user (a number) or pair (its id); made on the first call. Null: no result. */
export async function createShare(env: Env, of: number | string, userId: number) {
  const a = await latest(env.DB, of, READY);
  if (!a) return null;
  const old = await env.DB.prepare("SELECT id FROM analysis_shares WHERE analysis_id = ?").bind(a.id).first<string>("id");
  if (old) return { id: old, url: shareUrl(env, old) };
  const obj = await env.MEDIA.get(resultKey(a.id));
  if (!obj) return null;
  const result = sanitize(await obj.json());
  let body: object = { kind: "solo", result };
  if (typeof of === "string") {
    const p = await env.DB.prepare("SELECT * FROM pairs WHERE id = ?").bind(of).first<Pair>();
    if (!p?.b) return null;
    const [me, partner] = p.a === userId ? [p.a, p.b] : [p.b, p.a];
    const st = await pairStats(env, me, partner);
    const names = p.a === userId ? [p.a_name, p.b_name] : [p.b_name, p.a_name];
    // The page finds the sharer's side by stats.me.id = 0 in the owners.
    result.owners = p.a === userId ? [0, 1] : [1, 0];
    const shared = { ...st.shared, sources: [], twins: { ...st.shared.twins, items: [] } };
    body = { kind: "pair", result, stats: { ...st, me: { ...st.me, id: 0 }, partner: { ...st.partner, id: 1 }, shared }, names };
  }
  const sid = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("base64url");
  await env.MEDIA.put(shareKey(sid), JSON.stringify(body), { httpMetadata: { contentType: "application/json" } });
  await env.DB.prepare("INSERT INTO analysis_shares (id, analysis_id, user_id, pair_id) VALUES (?, ?, ?, ?)")
    .bind(sid, a.id, userId, a.pair_id)
    .run();
  return { id: sid, url: shareUrl(env, sid) };
}

/** Deletes links and their copies: `where` is an SQL condition over analysis_shares. */
export async function revokeShares(env: Env, where: string, ...args: unknown[]) {
  const { results } = await env.DB.prepare(`DELETE FROM analysis_shares WHERE ${where} RETURNING id`).bind(...args).all<{ id: string }>();
  if (results.length) await env.MEDIA.delete(results.map((r) => shareKey(r.id)));
}

/** GET /app/shared/analysis/<sid> — public, no login. The row is checked first, so a revoked link is gone at once. */
export async function handleSharedAnalysis(env: Env, sid: string) {
  const row = await env.DB.prepare("SELECT id FROM analysis_shares WHERE id = ?").bind(sid).first();
  const obj = row && (await env.MEDIA.get(shareKey(sid)));
  if (!obj) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(obj.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
