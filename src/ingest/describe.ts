import { botApi } from "../botapi";
import { DESCRIBE_FALLBACKS, DESCRIBE_MODELS, MODELS, VIDEO_INLINE_MAX_BYTES } from "../config";
import { getMeme, getUser, setStatus, userLang, type Meme } from "../db";
import type { Env } from "../env";
import { esc, t } from "../i18n";
import { memeMedia, toDataUrl, variantOf } from "../media";
import { chat, embed, type Part } from "../openrouter";
import { namespace, upsertVectors } from "./embed";

export interface Description {
  title: string;
  ocr_text: string;
  speech_text: string;
  language: string;
  description: string;
  meme_context: string;
  cultural_meaning: string;
  tags: string[];
  search_phrases: string[];
}

const str = { type: "string" };
const strs = { type: "array", items: str };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "ocr_text", "speech_text", "language", "description", "meme_context", "cultural_meaning", "tags", "search_phrases"],
  properties: {
    title: { type: "string", description: "Short title, max 80 chars" },
    ocr_text: { type: "string", description: "All visible text verbatim, original language, line breaks kept; empty if none" },
    speech_text: { type: "string", description: "Speech or lyrics verbatim (video only); empty if none" },
    language: { type: "string", description: "ISO 639-1 code of the meme text/speech, or 'none'" },
    description: { ...str, description: "Detailed visual description in English" },
    meme_context: { ...str, description: "Template/format, origin, source, the joke (English)" },
    cultural_meaning: { ...str, description: "How and when people use it, emotion, community/region (English)" },
    tags: { ...strs, description: "8-25 lowercase tags in English and in the meme language" },
    search_phrases: { ...strs, description: "5-15 phrases people would type to find it, English and meme language" },
  },
};

const PROMPT = `You index memes for a private meme search engine. Look at the attached image or video carefully.
1. Transcribe ALL visible text verbatim in its original language and script, keep line breaks. Do not translate, fix or censor it.
2. For video: transcribe speech or lyrics verbatim in speech_text. For images speech_text is "".
3. Identify the meme template or format, characters, people, the source (film, show, game, stream, event) and the joke.
   If you recognize or suspect a known meme, quote or person, use web_search to confirm the origin and meaning.
   Use web_fetch for pages such as Know Your Meme or Wikipedia. Do not search for generic images.
4. Explain the cultural meaning: when and how people use it, the emotion it conveys, the community or region.
5. Never invent facts. If something is unknown, say so briefly. Do not censor slang or swearing that people would search for.
6. description, meme_context and cultural_meaning are in English. tags and search_phrases are in English AND in the meme's own language (if different).
   Keep phrases that people would type to find this meme.
Reply with one JSON object only, with exactly these keys:
${Object.entries(SCHEMA.properties)
  .map(([k, v]) => `- ${k}: ${v.description}`)
  .join("\n")}`;

/** Parses model JSON, also when it is wrapped in a code fence or extra prose. */
export function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e <= s) throw new Error(`No JSON in model output: ${text.slice(0, 200)}`);
    return JSON.parse(text.slice(s, e + 1));
  }
}

/** Accepts an object, an array of one object, or an object wrapped in one key; fills missing fields. */
export function toDescription(raw: unknown, content: string): Description {
  const isDesc = (v: any) => v && typeof v === "object" && ["title", "description", "ocr_text"].some((k) => typeof v[k] === "string");
  let o: any = Array.isArray(raw) ? raw[0] : raw;
  if (!isDesc(o) && o && typeof o === "object") o = Object.values(o).find(isDesc);
  if (!isDesc(o)) throw new Error(`Bad description JSON: ${content.slice(0, 500)}`);
  const s = (k: string) => (typeof o[k] === "string" ? o[k].trim() : "");
  const a = (k: string) => (Array.isArray(o[k]) ? o[k].filter((x: unknown) => typeof x === "string" && x.trim()) : []);
  // Fallback title: first OCR line or first sentence of the description.
  const title = s("title") || s("ocr_text").split("\n")[0] || s("description").split(/(?<=[.!?])\s/)[0];
  return {
    title: title.slice(0, 80),
    ocr_text: s("ocr_text"),
    speech_text: s("speech_text"),
    language: s("language") || "none",
    description: s("description"),
    meme_context: s("meme_context"),
    cultural_meaning: s("cultural_meaning"),
    tags: a("tags").map((x: string) => x.toLowerCase().trim()),
    search_phrases: a("search_phrases"),
  };
}

export const docText = (d: Description) =>
  [d.title, d.ocr_text, d.speech_text, d.description, d.meme_context, d.cultural_meaning, d.tags.join(", "), d.search_phrases.join("\n")]
    .filter(Boolean)
    .join("\n");

/** Most used tags in the user's recent memes, so the model reuses them. */
export async function topTags(db: D1Database, userId: number, n = 30): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT tags FROM memes WHERE user_id = ? AND tags IS NOT NULL ORDER BY created_at DESC LIMIT 500")
    .bind(userId)
    .all<{ tags: string }>();
  const count = new Map<string, number>();
  for (const r of results) for (const tag of r.tags.split("\n")) if (tag) count.set(tag, (count.get(tag) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([tag]) => tag);
}

async function mediaPart(env: Env, m: Meme): Promise<Part[]> {
  if (m.kind === "photo") {
    return [{ type: "image_url", image_url: { url: toDataUrl(await memeMedia(env, m, "file")) } }];
  }
  if ((m.file_size ?? Infinity) <= VIDEO_INLINE_MAX_BYTES) {
    const media = await memeMedia(env, m, "file");
    return [{ type: "video_url", video_url: { url: toDataUrl(media) } }];
  }
  if (variantOf(m, "preview") !== "preview") throw new Error("Video too large and has no thumbnail");
  const thumb = await memeMedia(env, m, "preview");
  return [
    { type: "text", text: `Only a preview frame is available; the video is ${m.duration ?? "?"} s long.` },
    { type: "image_url", image_url: { url: toDataUrl(thumb) } },
  ];
}

/** Chat request that describes one meme. Without tools; the sync pipeline adds web tools. */
export type Tier = keyof typeof DESCRIBE_MODELS;

/** The owner's describe quality tier. */
export const userTier = async (db: D1Database, userId: number): Promise<Tier> => (await getUser(db, userId))?.describe_tier ?? "max";

/** Models to try in order: the tier's model, then cheaper ones when a provider blocks the photo. Videos have one. */
export const describeModels = (m: Pick<Meme, "kind">, tier: Tier) =>
  m.kind === "photo" ? [...new Set([DESCRIBE_MODELS[tier], ...DESCRIBE_FALLBACKS])] : [MODELS.describeVideo];

/** A provider's safety filter refused the request (an error, or an empty answer). */
export const isBlocked = (e: unknown) => /SAFETY|content.?(policy|filter)|PROHIBITED|blocked|moderation|empty answer/i.test(String(e));

export function describeRequest(m: Meme, usedTags: string[], media: Part[], tier: Tier = "max") {
  const context = [
    `Meme kind: ${m.kind}. User caption: ${JSON.stringify(m.caption ?? "")}. Forwarded from: ${JSON.stringify(m.source ?? "")}.`,
    usedTags.length ? `Most used tags in this collection (reuse them when they fit, add new ones when needed): ${usedTags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    model: m.kind === "photo" ? DESCRIBE_MODELS[tier] : MODELS.describeVideo,
    temperature: 0.2,
    messages: [
      { role: "system" as const, content: PROMPT },
      { role: "user" as const, content: [{ type: "text" as const, text: context }, ...media] },
    ],
    response_format: { type: "json_schema", json_schema: { name: "meme", strict: true, schema: SCHEMA } },
  };
}

const WEB_TOOLS = [
  { type: "openrouter:web_search", parameters: { max_results: 5, max_uses: 3 } },
  { type: "openrouter:web_fetch", parameters: { max_uses: 3, max_content_tokens: 20000 } },
];

/** Saves description fields (FTS updates by trigger); the meme stays 'describing' until finishStage. */
export const saveDescription = (db: D1Database, memeId: string, d: Description) =>
  db
    .prepare(
      `UPDATE memes SET title = ?, ocr_text = ?, speech_text = ?, language = ?, description = ?, meme_context = ?,
        cultural_meaning = ?, tags = ?, search_phrases = ?, updated_at = unixepoch() WHERE id = ? AND status = 'describing'`,
    )
    .bind(
      d.title.slice(0, 120),
      d.ocr_text,
      d.speech_text,
      d.language,
      d.description,
      d.meme_context,
      d.cultural_meaning,
      d.tags.join("\n"),
      d.search_phrases.join("\n"),
      memeId,
    );

const fromRow = (m: Meme): Description => ({
  title: m.title ?? "",
  ocr_text: m.ocr_text ?? "",
  speech_text: m.speech_text ?? "",
  language: m.language ?? "none",
  description: m.description ?? "",
  meme_context: m.meme_context ?? "",
  cultural_meaning: m.cultural_meaning ?? "",
  tags: m.tags ? m.tags.split("\n") : [],
  search_phrases: m.search_phrases ? m.search_phrases.split("\n") : [],
});

/**
 * Stage 2: describes the meme with web tools, then finishes it. A retry skips the paid call when the description is saved.
 * When a provider blocks the photo, the next model in describeModels tries it; `from` skips models that already refused.
 */
export async function describeStage(env: Env, memeId: string, from = 0) {
  const m = await getMeme(env.DB, memeId);
  if (!m || m.status !== "describing") return;
  if (m.title === null) {
    const tier = await userTier(env.DB, m.user_id);
    const body = { ...describeRequest(m, await topTags(env.DB, m.user_id), await mediaPart(env, m), tier), tools: WEB_TOOLS };
    const models = describeModels(m, tier);
    for (let i = Math.min(from, models.length - 1); ; i++) {
      try {
        const msg = await chat(env, { ...body, model: models[i] }, { userId: m.user_id, memeId, kind: "describe" });
        if (!msg.content?.trim()) throw new Error(`${models[i]}: empty answer`);
        await saveDescription(env.DB, memeId, toDescription(parseJson(msg.content), msg.content)).run();
        break;
      } catch (e) {
        if (i + 1 >= models.length || !isBlocked(e)) throw e;
        console.warn("describe blocked, next model", memeId, models[i], String(e).slice(0, 200));
      }
    }
  }
  await finishStage(env, memeId);
}

/** Stage 3: embeds the saved description, marks the meme ready and updates the status message. */
export async function finishStage(env: Env, memeId: string) {
  const m = await getMeme(env.DB, memeId);
  if (!m || m.status !== "describing" || m.title === null) return;
  const d = fromRow(m);
  const [values] = await embed(env, [docText(d)], "search_document", { userId: m.user_id, memeId, kind: "embed_text" });
  await upsertVectors(env, [{ id: `${memeId}:t`, values, namespace: namespace(m.user_id), metadata: { kind: m.kind } }]);
  await setStatus(env.DB, memeId, "ready");

  const tags = d.tags.slice(0, 8).map((x) => "#" + esc(x.replace(/[^\p{L}\p{N}_]+/gu, "_"))).join(" ");
  await editStatus(env, m, t(await userLang(env.DB, m.user_id), "saved", { title: esc(d.title), tags }));
}

export async function editStatus(env: Env, m: Meme, text: string) {
  if (!m.status_msg_id) return;
  await botApi(env.BOT_TOKEN).editMessageText(m.user_id, m.status_msg_id, text, { parse_mode: "HTML" }).catch(console.error);
}

/** Marks a meme as failed after the last retry and tells the user. */
export async function failIngest(env: Env, memeId: string, error: unknown) {
  const m = await getMeme(env.DB, memeId);
  if (!m) return;
  await setStatus(env.DB, memeId, "failed", String(error).slice(0, 1000));
  await editStatus(env, m, t(await userLang(env.DB, m.user_id), "index_failed"));
}
