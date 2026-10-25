import { cachedQueryEmbeddings } from "../cache";
import { AGENT_INITIAL, AGENT_MAX_STEPS, AGENT_MAX_VIEWS, CHAT_LIMIT, MODELS } from "../config";
import { loadMemes, type Meme } from "../db";
import type { Env } from "../env";
import { memeMedia, toDataUrl } from "../media";
import { chat, type ChatMessage, type Part } from "../openrouter";
import { hybridSearch } from "./hybrid";

const LIST_PAGE = 200;

const PROMPT = `You find memes in the user's personal meme collection.
You get the user's request and candidate memes found by a hybrid search (id, kind, title, tags, OCR text, description).
- If the candidates are weak, call search with better queries: caption fragments, template or character names, English and Russian variants.
- Call list_memes to browse the titles of all the user's memes when search does not find the right one.
- If text metadata is not enough to decide, call view_images to look at candidates.
- When done, reply without tool calls with ONLY the best 1-${CHAT_LIMIT} meme ids, best first, one per line. No other text.
- Never list ids that you did not get from a tool or the candidates. Reply with an empty message if nothing fits.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search",
      description: "Search the collection again with new queries. Returns new candidates only.",
      parameters: {
        type: "object",
        properties: { queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 } },
        required: ["queries"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memes",
      description: `List the user's memes (id, kind, title), newest first, ${LIST_PAGE} per page.`,
      parameters: {
        type: "object",
        properties: { offset: { type: "integer", minimum: 0, description: "Number of memes to skip" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_images",
      description: "Look at memes (images or video thumbnails).",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 } },
        required: ["ids"],
      },
    },
  },
];

/** Known meme ids from the final reply, in order, without duplicates. */
export function parseIds(content: string, known: Set<string>): string[] {
  return [...new Set(content.match(/\b[0-9a-f]{32}\b/g) ?? [])].filter((id) => known.has(id)).slice(0, CHAT_LIMIT);
}

const cut = (s: string | null, n: number) => (s && s.length > n ? s.slice(0, n) + "…" : s ?? "");
const brief = (m: Meme) => ({
  id: m.id,
  kind: m.kind,
  title: m.title ?? "",
  tags: m.tags?.split("\n").join(", ") ?? "",
  ocr_text: cut(m.ocr_text, 200),
  description: cut(m.description, 300),
});

const args = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

/** Advanced chat search: an LLM agent that can refine the search, list titles and look at images. */
export async function agentSearch(env: Env, userId: number, query: string): Promise<Meme[]> {
  const known = new Set<string>();
  const own = async (ids: string[]) => (await loadMemes(env.DB, ids)).filter((m) => m.user_id === userId);
  const find = async (texts: string[], limit: number) => {
    const vectors = await cachedQueryEmbeddings(env, texts, { userId, kind: "search_embed" });
    const found = (await hybridSearch(env, userId, { vectors, texts, limit })).filter((m) => !known.has(m.id));
    found.forEach((m) => known.add(m.id));
    return found;
  };
  const list = async (offset: number) => {
    const { results } = await env.DB.prepare(
      "SELECT id, kind, title FROM memes WHERE user_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
      .bind(userId, LIST_PAGE, offset)
      .all<{ id: string; kind: string; title: string }>();
    results.forEach((m) => known.add(m.id));
    return JSON.stringify({ memes: results, next_offset: results.length === LIST_PAGE ? offset + LIST_PAGE : null });
  };

  const initial = await find([query], AGENT_INITIAL);
  const messages: ChatMessage[] = [
    { role: "system", content: PROMPT },
    { role: "user", content: `Request: ${query}\n\nCandidates:\n${JSON.stringify(initial.map(brief))}` },
  ];
  let views = 0;

  for (let step = 0; step < AGENT_MAX_STEPS; step++) {
    const msg = await chat(
      env,
      { model: MODELS.search, messages, tools: TOOLS, tool_choice: step === AGENT_MAX_STEPS - 1 ? "none" : "auto" },
      { userId, kind: "agent_step" },
    );
    if (!msg.tool_calls?.length) return own(parseIds(msg.content ?? "", known));
    messages.push(msg);

    const images: Part[] = [];
    for (const call of msg.tool_calls) {
      const a = args(call.function.arguments);
      let result: string;
      if (call.function.name === "search") {
        const texts = (Array.isArray(a.queries) ? a.queries : []).filter((q: unknown) => typeof q === "string").slice(0, 5);
        result = texts.length ? JSON.stringify((await find(texts, 15)).map(brief)) : "Error: queries required";
      } else if (call.function.name === "list_memes") {
        result = await list(Number.isInteger(a.offset) && a.offset > 0 ? a.offset : 0);
      } else if (call.function.name === "view_images") {
        const ids = (Array.isArray(a.ids) ? a.ids : []).filter((id: string) => known.has(id));
        const memes = (await own(ids)).slice(0, Math.min(4, AGENT_MAX_VIEWS - views));
        for (const m of memes) {
          images.push({ type: "text", text: `id: ${m.id}` });
          images.push({ type: "image_url", image_url: { url: toDataUrl(await memeMedia(env, m, "preview")) } });
        }
        views += memes.length;
        result = memes.length ? `Attached ${memes.length} images: ${memes.map((m) => m.id).join(", ")}` : "No images: unknown ids or view limit reached";
      } else {
        result = "Error: unknown tool";
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    if (images.length) messages.push({ role: "user", content: images });
  }
  return [];
}
