import { botApi } from "../botapi";
import { DEFAULT_TIER, DESCRIBE_FALLBACKS, DESCRIBE_MODELS, DESCRIBE_UNCENSORED, DESCRIBE_VIDEO_FALLBACKS, MODELS, VIDEO_INLINE_MAX_BYTES } from "../config";
import { getMeme, getUser, setStatus, userLang, type Meme } from "../db";
import { ALBUM_WAIT, albumMemes, albumPhotos, queuePosts } from "../channels";
import type { Env } from "../env";
import { esc, t, type Lang } from "../i18n";
import { memeMedia, toDataUrl, variantOf } from "../media";
import { chat, embed, errorNote, type Part } from "../openrouter";
import { sha256hex } from "../cache";
import { namespace, upsertEmbedded } from "./embed";
import { showSaveStatus } from "../savewidget";

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
  porn: boolean; // sexual content in the picture or frames; false when not set
}

/** Metadata of the import source, kept in memes.source_meta: its tags join the meme tags, `porn` forces the porn flag. */
export interface SourceMeta {
  site: string;
  tags: string[];
  data: unknown;
  porn?: boolean;
}
const parseMeta = (m: Partial<Pick<Meme, "source_meta">>) => (m.source_meta ? (JSON.parse(m.source_meta) as SourceMeta) : null);

const str = { type: "string" };
const strs = { type: "array", items: str };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "ocr_text", "speech_text", "language", "description", "meme_context", "cultural_meaning", "tags", "search_phrases", "porn"],
  properties: {
    title: { type: "string", description: "Short title, max 80 chars" },
    ocr_text: { type: "string", description: "All visible text verbatim, original language, line breaks kept; empty if none" },
    speech_text: { type: "string", description: "Speech or lyrics verbatim (video only); empty if none" },
    language: { type: "string", description: "ISO 639-1 code of the meme text/speech, or 'none'" },
    description: { ...str, description: "Detailed visual description in English" },
    meme_context: { ...str, description: "Template/format, origin, source, the joke (English)" },
    cultural_meaning: { ...str, description: "How and when people use it, emotion, community/region (English)" },
    tags: { ...strs, description: "8-25 lowercase tags in English and in the meme language; sexual content: e621-style tags (rule 7)" },
    search_phrases: { ...strs, description: "5-15 phrases people would type to find it, English and meme language" },
    porn: {
      type: "boolean",
      description:
        "true only if the image or video frames show sexual content: sex acts, exposed genitals, pornographic nudity. Judge the picture only, not audio, speech or text",
    },
  },
};
const COMIC_PAGES = 10; // a comic is described in groups of this many consecutive pages
const COMIC_WAIT = 60; // seconds without new pages before a comic is described: it is imported in many jobs

/** The comic page group (one describe request) of the page `id`. */
const comicGroup = <T extends { id: string }>(album: T[], id: string) => {
  const start = Math.floor(album.findIndex((a) => a.id === id) / COMIC_PAGES) * COMIC_PAGES;
  return album.slice(start, start + COMIC_PAGES);
};
const ALBUM_SCHEMA = { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: SCHEMA } } };

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
7. Sexual content (porn: true) is the user's own adult collection: describe the scene plainly and in full, without euphemisms or moralizing:
   participants (number, apparent gender, species for furry art, art style), acts and positions, visible body parts, clothing, setting,
   fetishes, and the artist or characters if known. Use the words people search with.
   tags then follow e621 tagging: 25-60 real e621 tag names, lowercase, underscores for spaces, no namespaces, e.g.
   count (solo, duo, group), gender (male, female, intersex, male/female, male/male), form (anthro, feral, human, humanoid),
   species (canid, fox, wolf, felid, dragon, equid), body (breasts, penis, pussy, anus, muscular, overweight), nudity and clothing
   (nude, partially_clothed, lingerie), acts and positions (sex, oral, fellatio, penetration, vaginal_penetration, anal_penetration,
   masturbation, from_behind_position, missionary_position), fluids (cum, cum_inside), kinks (bondage, bdsm, feet, size_difference),
   art (digital_media_(artwork), comic, monochrome, 3d_(artwork)), the artist and characters as e621 names (e.g. character_name).
   Add a few tags in the meme language too.
   If anyone looks like a minor, do not describe sexual details: describe the image neutrally.
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
    porn: o.porn === true,
  };
}

/** Album answer: {"items": [...]} (or a bare array) with one description per photo, in order. */
export function toDescriptions(raw: any, content: string, n: number): Description[] {
  const items = Array.isArray(raw) ? raw : raw?.items;
  if (!Array.isArray(items) || items.length !== n) throw new Error(`Expected ${n} descriptions: ${content.slice(0, 500)}`);
  return items.map((o) => toDescription(o, content));
}

export const docText =(d: Description) =>
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

/** The picture or video of the meme; `frame`: the preview frame of a video (for models without video input). */
async function mediaPart(env: Env, m: Meme, frame = false): Promise<Part[]> {
  if (m.kind === "photo") {
    return [{ type: "image_url", image_url: { url: toDataUrl(await memeMedia(env, m, "file")) } }];
  }
  if (!frame && (m.file_size ?? Infinity) <= VIDEO_INLINE_MAX_BYTES) {
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
export const userTier = async (db: D1Database, userId: number): Promise<Tier> => (await getUser(db, userId))?.describe_tier ?? DEFAULT_TIER;

/**
 * Models to try in order: the tier's model, then other ones when a provider blocks or refuses the meme; the uncensored one is last.
 * It has no video input: a video gets it only when it has a preview frame.
 */
export const describeModels = (m: Pick<Meme, "kind" | "r2_preview" | "preview_file_id">, tier: Tier) =>
  m.kind === "photo"
    ? [...new Set([DESCRIBE_MODELS[tier], ...DESCRIBE_FALLBACKS, DESCRIBE_UNCENSORED])]
    : [MODELS.describeVideo, ...DESCRIBE_VIDEO_FALLBACKS, ...(m.r2_preview || m.preview_file_id ? [DESCRIBE_UNCENSORED] : [])];

/** A provider's safety filter blocked the request (an error, an empty answer) or the model refused it. */
export const isBlocked = (e: unknown) => /SAFETY|content.?(policy|filter)|PROHIBITED|blocked|moderation|empty answer|refused/i.test(String(e));

const REFUSAL = /\bI(?:['’]m| am)? (?:can['’]?t|cannot|won['’]?t|unable to|not able to) [^.]{0,40}?\b(?:describe|assist|comply|provide|help (?:you|with))|against my (?:guidelines|policy|policies)/i;
/** A short text that declines the request, like "I can't describe this image". */
export const isRefusal = (s: string) => s.length < 400 && REFUSAL.test(s);

/** Descriptions of a model answer (`n` for an album); throws "refused" (see isBlocked) when the model declined. */
export function parseAnswer(content: string, refusal: string | null | undefined, n = 1): Description[] {
  const text = content.trim();
  if (refusal || (!text.includes("{") && isRefusal(text))) throw new Error(`refused: ${refusal || text.slice(0, 200)}`);
  const raw = parseJson(text);
  const ds = n > 1 ? toDescriptions(raw, text, n) : [toDescription(raw, text)];
  if (ds.some((d) => isRefusal(d.title) || isRefusal(d.description))) throw new Error(`refused: ${text.slice(0, 200)}`);
  return ds;
}
/** OpenRouter or the provider failed after the retry: another model may work. */
export const isTransient = (e: unknown) => /OpenRouter \S+ (408|429|5\d\d) |fetch failed/i.test(String(e));

export function describeRequest(m: Meme, usedTags: string[], media: Part[], tier: Tier = DEFAULT_TIER) {
  const meta = parseMeta(m);
  const context = [
    `Meme kind: ${m.kind}. User caption: ${JSON.stringify(m.caption ?? "")}. Forwarded from: ${JSON.stringify(m.source ?? "")}.`,
    meta ? `Source metadata (${meta.site}): tags: ${meta.tags.join(", ")}; ${JSON.stringify(meta.data)}`.slice(0, 3000) : "",
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

const DESCRIPTION = ["title", "ocr_text", "speech_text", "language", "description", "meme_context", "cultural_meaning", "tags", "search_phrases", "porn"];

/**
 * Saves description fields (FTS updates by trigger) of this processing run; fields the user edited (`edits`) stay.
 * The meme stays 'describing' until finishStage.
 */
export const saveDescription = (db: D1Database, m: Pick<Meme, "id" | "gen"> & Partial<Pick<Meme, "source_meta">>, d: Description, status: Meme["status"] = "describing") => {
  const meta = parseMeta(m); // the tags and porn flag of the source always count
  return db
    .prepare(
      `UPDATE memes SET ${DESCRIPTION.map((k) => `${k} = COALESCE(json_extract(edits, '$.${k}'), ?)`).join(", ")},
        updated_at = unixepoch() WHERE id = ? AND status = ? AND gen = ?`,
    )
    .bind(
      d.title.slice(0, 120),
      d.ocr_text,
      d.speech_text,
      d.language,
      d.description,
      d.meme_context,
      d.cultural_meaning,
      [...new Set([...d.tags, ...(meta?.tags ?? []).map((x) => x.toLowerCase().trim())].filter(Boolean))].join("\n"),
      d.search_phrases.join("\n"),
      d.porn || meta?.porn ? 1 : 0,
      m.id,
      status,
      m.gen,
    );
};

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
  porn: !!m.porn,
});

/**
 * Stage 2: describes the meme with web tools, then finishes it. A retry skips the paid call when the description is saved.
 * When a provider blocks the meme or fails, the next model in describeModels tries it; `from` skips models that already refused.
 */
export async function describeStage(env: Env, memeId: string, from = 0, single = false, gen = 0) {
  const m = await getMeme(env.DB, memeId);
  if (!m || m.gen !== gen || m.status !== "describing") return;
  const edits = m.edits ? JSON.parse(m.edits) : {};
  // The user set all description fields (an edit before the meme got ready): no AI call.
  if (m.title === null && DESCRIPTION.every((k) => k in edits)) await saveDescription(env.DB, m, fromRow({ ...m, ...edits })).run();
  else if (m.title === null) {
    // Photos of a media group are described in one request: wait until the album is complete and embedded.
    const album = m.kind === "photo" && !single ? await albumPhotos(env.DB, memeId) : [];
    const comic = album[0]?.album_layout === "comic";
    const wait = comic ? COMIC_WAIT : ALBUM_WAIT;
    if (album.some((a) => a.status === "embedding") || (album.length && Date.now() / 1000 - album[0].album_updated < wait)) {
      await env.JOBS.send({ type: "describe", memeId, gen, from }, { delaySeconds: wait });
      return;
    }
    const head = comic ? comicGroup(album, memeId) : album; // a comic is described group by group
    const pending = head.filter((a) => a.status === "describing" && a.title === null);
    if (pending.length > 1 && pending[0].id !== memeId) return; // the first pending photo describes the album
    const group = pending.length > 1 ? pending : [m];
    const pages = comic ? ` They are pages ${album.indexOf(pending[0]) + 1}-${album.indexOf(pending.at(-1)!) + 1} of a comic of ${album.length} pages${album[0].caption ? ` (${JSON.stringify(album[0].caption)})` : ""}.` : "";
    try {
      await describeGroup(env, m, group, from, pages);
    } catch (e) {
      if (group.length === 1) throw e;
      // The album request failed: each photo is described alone.
      console.warn("album describe failed, one by one", memeId, String(e).slice(0, 200));
      await Promise.all(group.map((g) => env.JOBS.send({ type: "describe", memeId: g.id, gen: g.gen, single: true })));
      return;
    }
  }
  await finishStage(env, memeId, gen);
}

/** Describes the memes in one request (the first one is `m`) and saves the descriptions; the others get finish jobs. */
async function describeGroup(env: Env, m: Meme, group: Meme[], from: number, note = "") {
  const memeId = m.id;
  const tier = await userTier(env.DB, m.user_id);
  const tags = await topTags(env.DB, m.user_id);
  const build = async (frame: boolean) => {
    const media = group.length > 1
      ? (await Promise.all(group.map(async (g, i) => [{ type: "text" as const, text: `Image ${i + 1}. User caption: ${JSON.stringify(g.caption ?? "")}.` }, ...(await mediaPart(env, g))]))).flat()
      : await mediaPart(env, m, frame);
    const albumText = `This is an album of ${group.length} images sent together; use them as context for each other. Reply {"items": [...]} with one object per image, in order.${note}`;
    return {
      ...describeRequest(m, tags, group.length > 1 ? [{ type: "text", text: albumText }, ...media] : media, tier),
      tools: WEB_TOOLS,
      ...(group.length > 1 && { response_format: { type: "json_schema", json_schema: { name: "album", strict: true, schema: ALBUM_SCHEMA } } }),
    };
  };
  let body = await build(false);
  const models = describeModels(m, tier);
  for (let i = Math.min(from, models.length - 1); ; i++) {
    try {
      // The uncensored model has no video input: a video goes to it as its preview frame.
      if (m.kind !== "photo" && models[i] === DESCRIBE_UNCENSORED) body = await build(true);
      const msg = await chat(env, { ...body, model: models[i] }, { userId: m.user_id, memeId, kind: "describe" });
      if (!msg.content?.trim()) throw new Error(`${models[i]}: empty answer`);
      const ds = parseAnswer(msg.content, msg.refusal, group.length);
      await env.DB.batch(group.map((g, j) => saveDescription(env.DB, g, ds[j])));
      await Promise.all(group.slice(1).map((g) => env.JOBS.send({ type: "finish", memeId: g.id, gen: g.gen })));
      break;
    } catch (e) {
      if (i + 1 >= models.length || !(isBlocked(e) || isTransient(e))) throw e;
      console.warn("describe failed, next model", memeId, models[i], String(e).slice(0, 200));
    }
  }
}

/** Embeds the saved description of the meme (its text vector). */
export async function embedText(env: Env, m: Meme) {
  const doc = docText(fromRow(m));
  // The key holds the text hash: an edited text is embedded again.
  await upsertEmbedded(env, `${m.id}:t:${await sha256hex(doc)}`, { id: `${m.id}:t`, namespace: namespace(m.user_id), metadata: { kind: m.kind } }, async () =>
    (await embed(env, [doc], "search_document", { userId: m.user_id, memeId: m.id, kind: "embed_text" }))[0]);
}

/** Stage 3: embeds the saved description, marks the meme ready and updates the status message. */
export async function finishStage(env: Env, memeId: string, gen = 0) {
  const m = await getMeme(env.DB, memeId);
  if (!m || m.gen !== gen || m.status !== "describing" || m.title === null) return;
  const d = fromRow(m);
  await embedText(env, m);
  if (!(await setStatus(env.DB, memeId, "ready", null, gen)).meta.changes) return; // an edit restarted it

  const tags = d.tags.slice(0, 8).map((x) => "#" + esc(x.replace(/[^\p{L}\p{N}_]+/gu, "_"))).join(" ");
  const lang = await userLang(env.DB, m.user_id);
  const state = { s: "r", t: d.title.slice(0, 120), g: d.tags.slice(0, 8).map((x) => x.slice(0, 24)) };
  await editStatus(env, m, t(lang, "saved", { title: esc(d.title), tags }) + (await firstMemeTip(env, m, lang)), state);
  await queuePosts(env, memeId);
  await comicPorn(env, m);
}

/** One porn page makes the whole comic porn. */
async function comicPorn(env: Env, m: Meme) {
  const album = await albumMemes(env.DB, m.id);
  if (album[0]?.album_layout === "comic" && album.some((a) => a.porn))
    await env.DB.prepare("UPDATE memes SET porn = 1 WHERE porn = 0 AND id IN (SELECT meme_id FROM post_items WHERE post_id = ?)").bind(album[0].album_post).run();
}

/** A search hint under the first meme a user saves from the chat. */
async function firstMemeTip(env: Env, m: Meme, lang: Lang) {
  if (!m.status_msg_id) return "";
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM memes WHERE user_id = ? AND status = 'ready'").bind(m.user_id).first<number>("n");
  if (n !== 1) return "";
  const { username } = await botApi(env.BOT_TOKEN).getMe();
  return t(lang, "first_meme", { bot: username });
}

/**
 * Edits the meme's status message (widget state, see src/savewidget.ts); a message shared by an album shows the
 * progress of all its memes instead. Without a state the widget shows the text.
 */
export async function editStatus(env: Env, m: Meme, text: string, state: object = { s: "m", x: text.replace(/<[^>]+>/g, "") }) {
  if (!m.status_msg_id) return;
  const { results } = await env.DB.prepare(
    "SELECT m.status, m.title FROM memes m LEFT JOIN post_items i ON i.meme_id = m.id WHERE m.user_id = ? AND m.status_msg_id = ? ORDER BY i.position",
  )
    .bind(m.user_id, m.status_msg_id)
    .all<Pick<Meme, "status" | "title">>();
  if (results.length > 1) {
    const lang = await userLang(env.DB, m.user_id);
    const ready = results.filter((r) => r.status === "ready");
    const done = ready.length + results.filter((r) => r.status === "failed").length;
    const titles = (n: number) => ready.slice(0, n).map((r) => `• <b>${esc(r.title ?? "")}</b>`).join("\n");
    const final = done === results.length;
    const saved = (n: number) => t(lang, "album_saved", { ready: ready.length, total: results.length, titles: titles(n) });
    text = final ? saved(50) : t(lang, "album_progress", { done, total: results.length });
    const r = ready.slice(0, 8).map((x) => (x.title ?? "").slice(0, 60));
    // A caption holds 1024 characters: 10 titles.
    return showSaveStatus(env, m.user_id, m.status_msg_id, text, { n: results.length, d: done, r, s: final ? "r" : "i" }, final, final ? saved(10) : text);
  }
  await showSaveStatus(env, m.user_id, m.status_msg_id, text, state, true);
}

/** Marks a meme as failed after the last retry and tells the user. */
export async function failIngest(env: Env, memeId: string, error: unknown, gen = 0) {
  const m = await getMeme(env.DB, memeId);
  if (!m || !(await setStatus(env.DB, memeId, "failed", String(error).slice(0, 1000), gen)).meta.changes) return; // an edit restarted it
  await editStatus(env, m, t(await userLang(env.DB, m.user_id), "index_failed", { error: errorNote(error) }), { s: "f", e: errorNote(error) });
  await queuePosts(env, memeId); // the media is fine: post it anyway
}
