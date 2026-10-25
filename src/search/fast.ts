import { cachedQueryEmbeddings } from "../cache";
import { FAST_LLM_TIMEOUT_MS, MODELS } from "../config";
import type { Env } from "../env";
import { parseJson } from "../ingest/describe";
import { chat } from "../openrouter";
import { hybridSearch } from "./hybrid";

const PROMPT = `Rewrite the user's request into 3-5 short, different search queries for a personal meme collection.
Memes are indexed by verbatim OCR text, English description, template and character names, and tags in English and the meme's language.
Include an English and a Russian variant, a probable caption fragment, and template or character names if implied.
Reply with JSON: {"queries": ["..."]}`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: { queries: { type: "array", items: { type: "string" } } },
};

async function rewrite(env: Env, userId: number, query: string): Promise<string[]> {
  const msg = await chat(
    env,
    {
      model: MODELS.search,
      max_tokens: 200,
      provider: { sort: "latency" },
      reasoning: { enabled: false },
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: query },
      ],
      response_format: { type: "json_schema", json_schema: { name: "queries", strict: true, schema: SCHEMA } },
    },
    { userId, kind: "search_llm" },
    AbortSignal.timeout(FAST_LLM_TIMEOUT_MS),
  );
  const { queries } = parseJson<{ queries: unknown[] }>(msg.content ?? "");
  return queries.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, 5);
}

/** Fast preset: embeds the query while the LLM writes extra queries, then one hybrid search. */
export async function fastSearch(env: Env, userId: number, query: string, limit: number) {
  const spend = { userId, kind: "search_embed" };
  const [raw, extra] = await Promise.all([
    cachedQueryEmbeddings(env, [query], spend),
    rewrite(env, userId, query)
      .then(async (texts) => ({ texts, vectors: texts.length ? await cachedQueryEmbeddings(env, texts, spend) : [] }))
      .catch((e) => {
        console.warn("query rewrite failed", e);
        return { texts: [] as string[], vectors: [] as number[][] };
      }),
  ]);
  return hybridSearch(env, userId, { vectors: [...raw, ...extra.vectors], texts: [query, ...extra.texts], limit });
}
