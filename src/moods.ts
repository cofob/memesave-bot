// Mood anchors of an analysis (GET /analysis/<id>/moods): LLM-written phrases of emotional tones that fit the collection
// (both of a pair), embedded as search queries; the container scores each meme's text vector against them.
import type { Analysis } from "./analysis";
import { canUseAi } from "./billing";
import { DEFAULT_MOODS, MODELS } from "./config";
import { tagStats } from "./analytics";
import { getUser } from "./db";
import type { Env } from "./env";
import { parseJson } from "./ingest/describe";
import { tmpKey } from "./media";
import { chat, embed } from "./openrouter";

type Mood = (typeof DEFAULT_MOODS)[number];
export type Anchor = Omit<Mood, "phrases"> & { vector: number[] };

const LANGS: Record<string, string> = { en: "English", ru: "Russian", uk: "Ukrainian", de: "German", es: "Spanish", fr: "French", pt: "Portuguese", it: "Italian", pl: "Polish", tr: "Turkish" };
const str = { type: "string" };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["moods"],
  properties: {
    moods: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "emoji", "name_en", "name_ru", "phrases"],
        properties: { key: str, emoji: str, name_en: str, name_ru: str, phrases: { type: "array", items: str } },
      },
    },
  },
};

/** The prompt input: top tags, meme languages and UI languages of each person; target languages are the meme ones of ≥10% and the UI ones. */
async function profile(db: D1Database, users: number[]) {
  const sides = await Promise.all(
    users.map(async (id) => {
      const [{ results: tags }, { results: langs }, ui] = await Promise.all([
        db.prepare("SELECT tags, '' AS month FROM memes WHERE user_id = ? AND status = 'ready' AND tags IS NOT NULL").bind(id).all<{ tags: string; month: string }>(),
        db.prepare("SELECT language AS k, COUNT(*) AS n FROM memes WHERE user_id = ? AND status = 'ready' AND language IS NOT NULL AND language != 'none' GROUP BY k").bind(id).all<{ k: string; n: number }>(),
        db.prepare("SELECT lang FROM users WHERE id = ?").bind(id).first<string>("lang"),
      ]);
      const total = langs.reduce((s, l) => s + l.n, 0) || 1;
      return { tags: tagStats(tags).top.slice(0, 40).map((t) => t.tag), langs: langs.map((l) => ({ k: l.k, share: l.n / total })), ui: ui === "ru" ? "ru" : "en" };
    }),
  );
  const targets = [...new Set(sides.flatMap((s) => [...s.langs.filter((l) => l.share >= 0.1).map((l) => l.k), s.ui]))].filter((k) => LANGS[k]);
  return { sides, targets };
}

/** 10–14 moods with 3–6 phrases per target language from one LLM call; null when it fails. */
async function llmMoods(env: Env, payer: number, users: number[], kind: string): Promise<Mood[] | null> {
  const { sides, targets } = await profile(env.DB, users);
  const input = sides
    .map((s, i) => `Person ${"AB"[i]}\ntop tags: ${s.tags.join(", ")}\nmeme languages: ${s.langs.map((l) => `${l.k} ${Math.round(100 * l.share)}%`).join(", ") || "-"}\napp language: ${s.ui}`)
    .join("\n\n");
  const msg = await chat(
    env,
    {
      model: MODELS.search,
      max_tokens: 4000,
      reasoning: { enabled: false },
      messages: [
        {
          role: "system",
          content: `${users.length > 1 ? "Two friends compare their meme collections. Pick 10-14 moods (emotional tones) that best tell their memes apart and fit these collections" : "This is one person's meme collection. Pick 10-14 moods (emotional tones) that best describe the range of its memes"}, e.g. absurd, sarcasm, dark humor, cute, cringe, nostalgia. A mood is a tone, never a topic. For each: key — a short lowercase English id; emoji — one emoji; name_en and name_ru — 1-2 word names; phrases — 3-6 short phrases in EACH of ${targets.map((k) => LANGS[k]).join(", ")} that describe how a meme of this tone feels (not what it is about), like a search query. Reply with JSON: {"moods": [{"key", "emoji", "name_en", "name_ru", "phrases"}]}`,
        },
        { role: "user", content: input },
      ],
      response_format: { type: "json_schema", json_schema: { name: "moods", strict: true, schema: SCHEMA } },
    },
    { userId: payer, kind },
  );
  const moods = (parseJson<{ moods?: Mood[] }>(msg.content ?? "").moods ?? [])
    .filter((m) => m.key && m.phrases?.length)
    .slice(0, 14)
    .map((m) => ({ key: String(m.key).slice(0, 30), emoji: String(m.emoji).slice(0, 8), name_en: String(m.name_en).slice(0, 40), name_ru: String(m.name_ru).slice(0, 40), phrases: m.phrases.slice(0, 30).map((p) => String(p).slice(0, 200)) }));
  return moods.length >= 6 ? moods : null;
}

const EMBED_CHUNK = 50; // the embedding API refuses long batches (an LLM set is 100+ phrases)

/** Anchor = the normalized mean of its phrase vectors. */
async function anchors(env: Env, payer: number, moods: Mood[], kind: string): Promise<Anchor[]> {
  const phrases = moods.flatMap((m) => m.phrases);
  const chunks = Array.from({ length: Math.ceil(phrases.length / EMBED_CHUNK) }, (_, i) => phrases.slice(i * EMBED_CHUNK, (i + 1) * EMBED_CHUNK));
  const vectors = (await Promise.all(chunks.map((c) => embed(env, c, "search_query", { userId: payer, kind })))).flat();
  let i = 0;
  return moods.map(({ phrases, ...m }) => {
    const sum = vectors.slice(i, (i += phrases.length)).reduce((s, v) => s.map((x, j) => x + v[j]));
    const norm = Math.hypot(...sum) || 1;
    return { ...m, vector: sum.map((x) => x / norm) };
  });
}

/**
 * The mood anchors of an analysis of `users` (one, or the pair), cached in R2 so a container restart does not pay again.
 * The LLM writes them when the analysis has llm; DEFAULT_MOODS otherwise or when it fails. Null without AI.
 */
export async function analysisMoods(env: Env, a: Analysis, users: number[]): Promise<Anchor[] | null> {
  const key = tmpKey(`analysis/${a.id}/moods.json`);
  const cached = await env.MEDIA.get(key);
  if (cached) return cached.json<Anchor[]>();
  const payer = await getUser(env.DB, a.user_id);
  if (!payer || !(await canUseAi(env.DB, payer)).ok) return null;
  const kind = users.length > 1 ? "pair_moods" : "analysis_moods";
  const moods = (a.llm && (await llmMoods(env, payer.id, users, kind).catch((e) => (console.error("llm moods", e), null)))) || DEFAULT_MOODS;
  const result = await anchors(env, payer.id, moods, kind).catch(async (e) => {
    if (moods === DEFAULT_MOODS) throw e;
    console.error("mood anchors", e); // e.g. odd LLM phrases: the default moods instead
    return anchors(env, payer.id, DEFAULT_MOODS, kind);
  });
  await env.MEDIA.put(key, JSON.stringify(result), { httpMetadata: { contentType: "application/json" } });
  return result;
}
