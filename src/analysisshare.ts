// Public links of analysis results: a sanitized permanent copy (no AI spend, sources or meme ids) at /?analysis=<sid>.
import { Buffer } from "node:buffer";
import { latest, READY, resultKey } from "./analysis";
import type { Env } from "./env";
import type { Pair } from "./pairs";
import { pairStats } from "./pairstats";

export const shareKey = (sid: string) => `share/analysis/${sid}.json`;
export const shareUrl = (env: Env, sid: string) => `${env.PUBLIC_URL.replace(/\/$/, "")}/?analysis=${sid}`;
const EMPTY_SPEND = { days: [], models: [], keys: [], covered: { allowance: 0, balance: 0, total: 0 }, perMeme: [] };

export type Parts = { normal: boolean; porn: boolean };
const partsText = (p: Parts) => [p.normal && "normal", p.porn && "porn"].filter(Boolean).join(",");
const noSources = (p: any) => p && { ...p, sources: [] };

/** Removes the private parts of a result: spend, source names and the meme previews (meme ids of lists).
 * `parts` picks what stays: the normal stats and/or the porn stats. */
export function sanitize(r: any, parts: Parts = { normal: true, porn: false }) {
  const out = { ...r, clusters: (r.clusters ?? []).map((c: any) => ({ ...c, sample: [] })) };
  delete out.images;
  delete out.titles;
  const porn = parts.porn ? noSources(r.analytics?.porn) : undefined;
  if (r.owners) {
    // The pair snapshot may be older than a hide_porn switch: the porn of a pair comes from the live stats only.
    const analytics = r.analytics && { ...r.analytics, porn: undefined };
    return parts.normal ? { ...out, analytics, owners: [0, 1], twins: [], rhymes: [], for: [[], []], surprise: [[], []], bridge: [] } : { owners: [0, 1] };
  }
  const a = r.analytics;
  if (!parts.normal) return { count: r.count, analytics: { porn: porn ?? null, lang: a?.lang } };
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
      porn: porn ?? null,
    },
  };
}

/** The link of the latest finished analysis of the user (a number) or pair (its id) with the chosen parts; made on the first call,
 * a link with other parts is replaced. Null: no result; "parts": nothing to share (porn is never shared by a user who hides it). */
export async function createShare(env: Env, of: number | string, userId: number, want: Parts = { normal: true, porn: false }) {
  const hide = await env.DB.prepare("SELECT hide_porn FROM users WHERE id = ?").bind(userId).first<number>("hide_porn");
  const parts = { normal: want.normal, porn: want.porn && !hide };
  if (!parts.normal && !parts.porn) return "parts";
  const a = await latest(env.DB, of, READY);
  if (!a) return null;
  const old = await env.DB.prepare("SELECT id, parts FROM analysis_shares WHERE analysis_id = ?").bind(a.id).first<{ id: string; parts: string }>();
  if (old?.parts === partsText(parts)) return { id: old.id, url: shareUrl(env, old.id) };
  const obj = await env.MEDIA.get(resultKey(a.id));
  if (!obj) return null;
  if (old) await revokeShares(env, "analysis_id = ?", a.id);
  const result = sanitize(await obj.json(), parts);
  let body: object = { kind: "solo", parts, result };
  if (typeof of === "string") {
    const p = await env.DB.prepare("SELECT * FROM pairs WHERE id = ?").bind(of).first<Pair>();
    if (!p?.b) return null;
    const [me, partner] = p.a === userId ? [p.a, p.b] : [p.b, p.a];
    const st = await pairStats(env, me, partner);
    const names = p.a === userId ? [p.a_name, p.b_name] : [p.b_name, p.a_name];
    // The page finds the sharer's side by stats.me.id = 0 in the owners.
    result.owners = p.a === userId ? [0, 1] : [1, 0];
    const shared = { ...st.shared, sources: [], twins: { ...st.shared.twins, items: [] } };
    const porn = parts.porn && st.porn ? { ...st.porn, me: noSources(st.porn.me), partner: noSources(st.porn.partner) } : null;
    const stats = parts.normal
      ? { ...st, me: { ...st.me, id: 0 }, partner: { ...st.partner, id: 1 }, shared, porn }
      : { me: { id: 0, name: st.me.name }, partner: { id: 1, name: st.partner.name }, porn };
    body = { kind: "pair", parts, result, stats, names };
  }
  const sid = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("base64url");
  await env.MEDIA.put(shareKey(sid), JSON.stringify(body), { httpMetadata: { contentType: "application/json" } });
  await env.DB.prepare("INSERT INTO analysis_shares (id, analysis_id, user_id, pair_id, parts) VALUES (?, ?, ?, ?, ?)")
    .bind(sid, a.id, userId, a.pair_id, partsText(parts))
    .run();
  return { id: sid, url: shareUrl(env, sid) };
}

/** POST .../share: the body `{ normal?, porn? }` picks the parts (the normal stats by default); both off is a 400. */
export async function handleShare(req: Request, env: Env, of: number | string, userId: number) {
  const b = await req.json<{ normal?: boolean; porn?: boolean }>().catch(() => ({}) as { normal?: boolean; porn?: boolean });
  const link = await createShare(env, of, userId, { normal: b.normal ?? !b.porn, porn: !!b.porn });
  const [body, status] = link === "parts" ? [{ error: "nothing to share" }, 400] : link ? [link, 200] : [{ error: "no result" }, 404];
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
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
