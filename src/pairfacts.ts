// LLM facts of a pair analysis: a nickname, a verdict, facts and awards from a compact summary of the result,
// one call per language of the members; stored in result.facts[lang].
import type { Analysis, Cluster } from "./analysis";
import { canUseAi } from "./billing";
import { MODELS } from "./config";
import { getUser, userLang } from "./db";
import type { Env } from "./env";
import type { Lang } from "./i18n";
import { parseJson } from "./ingest/describe";
import { chat } from "./openrouter";
import type { PairStats } from "./pairstats";

export interface Facts {
  title: string;
  verdict: string;
  facts: string[];
  awards: { name: string; winner: "a" | "b" | "both"; reason: string }[];
}

/** The part of the container's pair result (analyze/pair.go) the Worker reads; owners and facts are added on PUT. */
export interface PairResult {
  owners?: [number, number];
  count: [number, number];
  clusters: (Cluster & { share: [number, number]; type: string; first: number })[];
  scores: { compat: number; mixing: number; centroid: number; moodSim: number; hourSim: number };
  twins: [string, string, number][];
  rhymes: [string, string, number][];
  bridge: string[];
  for: [string[], string[]];
  surprise: [string[], string[]];
  influence: { clusters: [number, number]; twins: [number, number]; score: [number, number] };
  moods: { keys: string[]; emoji: string[]; names: Record<string, string[]>; months: string[]; a: (number[] | null)[]; b: (number[] | null)[]; overall: [number[] | null, number[] | null]; sim: (number | null)[]; top: [number, number] } | null;
  analytics: PairStats & { lang: Lang };
  images?: string[];
  facts?: Partial<Record<Lang, Facts>>;
}

const str = { type: "string" };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "verdict", "facts", "awards"],
  properties: {
    title: str,
    verdict: str,
    facts: { type: "array", items: str },
    awards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "winner", "reason"],
        properties: { name: str, winner: { type: "string", enum: ["a", "b", "both"] }, reason: str },
      },
    },
  },
};

/** Titles of memes of the pair by id. */
async function titles(db: D1Database, owners: number[], ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 90);
  if (!unique.length) return new Map<string, string>();
  const { results } = await db
    .prepare(`SELECT id, COALESCE(title, '') AS title FROM memes WHERE user_id IN (?, ?) AND id IN (${unique.map(() => "?").join(",")})`)
    .bind(...owners, ...unique)
    .all<{ id: string; title: string }>();
  return new Map(results.map((r) => [r.id, r.title]));
}

/** The hours (UTC) with the most memes. */
const peaks = (cells: { h: number; n: number }[]) => {
  const hours = new Array<number>(24).fill(0);
  for (const c of cells) hours[c.h] += c.n;
  return hours.map((n, h) => ({ h, n })).sort((x, y) => y.n - x.n).slice(0, 3).map((x) => x.h);
};

/** A compact summary of the result for the prompt (names as A and B). */
async function summary(env: Env, r: PairResult, owners: number[]) {
  const s = r.analytics;
  const t = await titles(env.DB, owners, [...r.rhymes.slice(0, 5).flat(), ...r.bridge].filter((x): x is string => typeof x === "string"));
  const name = (c: Cluster) => c.name ?? c.tags.slice(0, 3).join(", ");
  const mood = (o: 0 | 1) => {
    const m = r.moods;
    const d = m?.overall[o];
    return d ? d.map((p, k) => ({ k: m.names.en?.[k] ?? m.keys[k], p })).sort((x, y) => y.p - x.p).slice(0, 4).map((x) => `${x.k} ${Math.round(100 * x.p)}%`) : [];
  };
  return JSON.stringify({
    memes: { A: s.me.ready, B: s.partner.ready },
    scores: r.scores,
    clusters: r.clusters.slice(0, 15).map((c) => ({ name: name(c), tags: c.tags.slice(0, 5), A: c.share[0], B: c.share[1], type: c.type, first: c.first < 0 ? null : "AB"[c.first] })),
    twins: { near_copies: r.twins.length, exact: s.shared.twins.count, saved_first: { A: s.shared.twins.first.me, B: s.shared.twins.first.partner } },
    influence: { A: r.influence.score[0], B: r.influence.score[1] },
    moods: r.moods && { A: mood(0), B: mood(1), match_by_month: Object.fromEntries(r.moods.months.map((m, i) => [m, r.moods!.sim[i]])) },
    peak_hours_utc: { A: peaks(s.me.heatmap), B: peaks(s.partner.heatmap) },
    shared_tags: s.shared.tags.slice(0, 15).map((x) => x.tag),
    only_A_tags: s.shared.unique_me.slice(0, 8).map((x) => x.tag),
    only_B_tags: s.shared.unique_partner.slice(0, 8).map((x) => x.tag),
    shared_sources: s.shared.sources.slice(0, 8).map((x) => x.name),
    rhymes: r.rhymes.slice(0, 5).map(([x, y]) => [t.get(x), t.get(y)]),
    bridge: r.bridge.map((id) => t.get(id)),
  });
}

/** Facts for each member's language; one failed call only leaves its language out. */
export async function pairFacts(env: Env, a: Analysis, r: PairResult) {
  const owners = r.owners ?? [];
  const payer = await getUser(env.DB, a.user_id);
  if (owners.length !== 2 || !payer || !(await canUseAi(env.DB, payer)).ok) return false;
  const input = await summary(env, r, owners);
  const names = `A=${r.analytics.me.name ?? "A"}, B=${r.analytics.partner.name ?? "B"}`;
  const langs = [...new Set(await Promise.all(owners.map((id) => userLang(env.DB, id))))];
  const facts: Partial<Record<Lang, Facts>> = {};
  for (const lang of langs) {
    const f = await chat(
      env,
      {
        model: MODELS.search,
        max_tokens: 3000,
        reasoning: { enabled: false },
        messages: [
          {
            role: "system",
            content: `Two friends compared their meme collections: ${names}. From the stats below write in ${lang === "ru" ? "Russian" : "English"}, playful and specific, using their names: title — a funny nickname of the pair; verdict — 1-2 sentences about how compatible their meme tastes are; facts — 8-12 short surprising facts from the numbers; awards — 4-6 funny awards (e.g. "Night owl of the year", "Pioneer", "King of cringe") with winner "a", "b" or "both" and a one-line reason. Reply with JSON: {"title", "verdict", "facts", "awards": [{"name", "winner", "reason"}]}`,
          },
          { role: "user", content: input },
        ],
        response_format: { type: "json_schema", json_schema: { name: "facts", strict: true, schema: SCHEMA } },
      },
      { userId: payer.id, kind: "pair_facts" },
    )
      .then((m) => parseJson<Facts>(m.content ?? ""))
      .catch((e) => (console.warn("pair facts failed", lang, e), null));
    if (f?.title)
      facts[lang] = {
        title: String(f.title).slice(0, 100),
        verdict: String(f.verdict).slice(0, 500),
        facts: (f.facts ?? []).slice(0, 12).map((x) => String(x).slice(0, 300)),
        awards: (f.awards ?? []).slice(0, 8).map((x) => ({ name: String(x.name).slice(0, 60), winner: ["a", "b"].includes(x.winner) ? x.winner : "both", reason: String(x.reason).slice(0, 200) })),
      };
  }
  if (Object.keys(facts).length) r.facts = facts;
  return !!r.facts;
}
