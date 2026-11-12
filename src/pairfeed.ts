import { analysisResult } from "./analysis";
import { ALBUM_FIRST, getMeme, storageFull, type Meme } from "./db";
import type { Env } from "./env";
import { DATE, feedPage, USES, type FeedMeme } from "./feed";
import { namespace, upsertVectors } from "./ingest/embed";
import type { PairResult } from "./pairfacts";
import { getPair } from "./pairs";

export const PAIR_MODES = ["mix", "theirs", "twins", "rhymes", "foryou", "surprise", "bridge", "guess"] as const;
export type PairMode = (typeof PAIR_MODES)[number];
type ListMode = Exclude<PairMode, "mix" | "theirs" | "guess">;
export const pairMode = (s: string | null | undefined): PairMode | null => (PAIR_MODES.includes(s as PairMode) ? (s as PairMode) : null);

/** Meme ids of the list modes for side `o` of a pair result: own memes first in twins and rhymes, the bridge from own taste. */
function lists(r: PairResult, o: number): Record<ListMode, string[]> {
  const pairs = (xs: [string, string, number][]) => xs.flatMap(([a, b]) => (o ? [b, a] : [a, b]));
  return { twins: pairs(r.twins), rhymes: pairs(r.rhymes), foryou: r.for[o], surprise: r.surprise[o], bridge: o ? [...r.bridge].reverse() : r.bridge };
}

/**
 * The pair feed of `me`: the partner, the modes available now and (with `withLists`) the list modes' ids of the latest
 * finished pair analysis. Partner memes only while the partner shares. Null unless `me` is in the active pair.
 */
export async function pairFeed(env: Env, me: number, pairId: string, withLists = true) {
  const p = await getPair(env.DB, me, pairId);
  if (p?.status !== "active") return null;
  const shares = p.they_share;
  const r = shares && withLists ? await (await analysisResult(env, pairId)).json<PairResult | null>() : null;
  const o = r?.owners?.indexOf(me) ?? -1;
  const ids = r && o >= 0 ? lists(r, o) : null;
  const has = (m: PairMode) => (m === "mix" ? true : m === "theirs" || m === "guess" ? shares : !!ids?.[m].length);
  return { id: pairId, me, partner: p.partner.id!, name: p.partner.name ?? p.partner.username ?? "?", users: shares ? [me, p.partner.id!] : [me], ids, modes: PAIR_MODES.filter(has) };
}
export type PairFeed = NonNullable<Awaited<ReturnType<typeof pairFeed>>>;

/**
 * One page of the pair feed in one of `f.modes`. seed: the random order of mix and guess; for theirs, the start of the
 * feed session (partner memes the viewer saw before it go last). No porn when either member of the pair hides it.
 */
export async function pairPage(env: Env, f: PairFeed, mode: PairMode, q: { seed: number; offset: number; limit: number; hidePorn?: boolean }) {
  const hidePorn = q.hidePorn || !!(await env.DB.prepare("SELECT MAX(hide_porn) FROM users WHERE id IN (?, ?)").bind(f.me, f.partner).first<number>("MAX(hide_porn)"));
  if (mode === "mix" || mode === "guess") return feedPage(env.DB, f.users, { ...q, hidePorn, mode: "random" });
  const porn = hidePorn ? " AND porn = 0" : "";
  const { results } =
    mode === "theirs"
      ? await env.DB.prepare(
          `SELECT *, ${USES} AS uses, ${DATE} AS date FROM memes WHERE user_id = ? AND status != 'failed' AND ${ALBUM_FIRST}${porn}
           ORDER BY EXISTS (SELECT 1 FROM meme_views v WHERE v.user_id = ? AND v.meme_id = memes.id AND v.seen_at < ?), ${DATE} DESC, memes.rowid LIMIT ? OFFSET ?`,
        )
          .bind(f.partner, f.me, q.seed, q.limit + 1, q.offset)
          .all<FeedMeme>()
      : await env.DB.prepare(
          `SELECT memes.*, ${USES} AS uses, ${DATE} AS date FROM json_each(?) j JOIN memes ON memes.id = j.value
           WHERE memes.user_id IN (${f.users.map(() => "?").join(",")}) AND status != 'failed' AND ${ALBUM_FIRST}${porn} ORDER BY j.key LIMIT ? OFFSET ?`,
        )
          .bind(JSON.stringify(f.ids?.[mode] ?? []), ...f.users, q.limit + 1, q.offset)
          .all<FeedMeme>();
  return { memes: results.slice(0, q.limit), more: results.length > q.limit };
}

export const ownerOf = (f: PairFeed, m: Pick<Meme, "user_id">) => (m.user_id === f.me ? "me" : "partner");

/** The answer of the guess game for meme `id`; null when it is not a visible meme of the pair. */
export async function checkGuess(env: Env, f: PairFeed, id: string, owner: string) {
  const m = await getMeme(env.DB, id);
  if (!m || !f.users.includes(m.user_id)) return null;
  return { correct: ownerOf(f, m) === owner, owner: ownerOf(f, m) };
}

// Copied as is: the description and AI fields too, so the copy needs no AI work. Not the partner's Telegram message and dates.
const COPY = `kind, file_id, file_unique_id, preview_file_id, preview_unique_id, mime, file_size, width, height, duration, caption, source,
  status, title, description, ocr_text, speech_text, meme_context, cultural_meaning, language, tags, search_phrases, porn, sha256`;

/** Copies a ready meme (of a partner) into the user's collection with its R2 files and vectors; the own copy when already saved. */
export async function copyMeme(env: Env, userId: number, m: Meme) {
  const own = () =>
    env.DB.prepare("SELECT id FROM memes WHERE user_id = ? AND (file_unique_id = ? OR sha256 = ?)").bind(userId, m.file_unique_id, m.sha256).first<string>("id");
  const old = await own();
  if (old) return { id: old, duplicate: true };
  if (m.status !== "ready") return { error: "not ready", status: 409 as const };
  if (await storageFull(env.DB, userId, m.file_size ?? 0)) return { error: "storage full", status: 507 as const };
  const id = crypto.randomUUID().replaceAll("-", "");
  const key = (k: string | null) => k && `memes/${id}/${k.split("/").pop()}`; // "" (no file) stays
  const inserted = await env.DB.prepare(
    `INSERT INTO memes (id, user_id, ${COPY}, r2_file, r2_preview, added_via) SELECT ?, ?, ${COPY}, ?, ?, 'pair' FROM memes WHERE id = ?
     ON CONFLICT DO NOTHING RETURNING id`,
  )
    .bind(id, userId, key(m.r2_file), key(m.r2_preview), m.id)
    .first<string>("id");
  if (!inserted) return { id: (await own())!, duplicate: true };
  // A missing R2 object is downloaded from Telegram again on the first read (memeMedia).
  for (const k of [m.r2_file, m.r2_preview]) {
    const obj = k ? await env.MEDIA.get(k) : null;
    if (obj) await env.MEDIA.put(key(k)!, await obj.arrayBuffer(), { httpMetadata: obj.httpMetadata });
  }
  const vectors = await env.VECTORS.getByIds([`${m.id}:i`, `${m.id}:t`]);
  if (vectors.length)
    await upsertVectors(env, vectors.map((v) => ({ id: v.id.replace(m.id, id), values: Array.from(v.values), namespace: namespace(userId), metadata: v.metadata })));
  return { id, duplicate: false };
}
