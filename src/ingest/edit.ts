import { getMeme, type Meme } from "../db";
import type { Env } from "../env";
import { embedText } from "./describe";

// Edits of a saved meme by the user (API, MCP, web): its description and metadata; the media stays.

const TEXT = { title: 120, ocr_text: 100_000, speech_text: 100_000, language: 20, description: 100_000, meme_context: 100_000, cultural_meaning: 100_000, caption: 4096, source: 500 };
const LISTS = ["tags", "search_phrases"] as const;
/** Fields of the text vector (docText): a change embeds the description again. */
const EMBEDDED = ["title", "ocr_text", "speech_text", "description", "meme_context", "cultural_meaning", "tags", "search_phrases"];

export type MemeEdit = Partial<Record<keyof typeof TEXT, string> & Record<(typeof LISTS)[number], string[]> & { porn: boolean; saved_at: number | null }>;

/** The checked edit; a string is an error. */
export function parseEdit(raw: unknown): MemeEdit | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "a JSON object of fields expected";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k in TEXT) {
      if (typeof v !== "string" || v.length > TEXT[k as keyof typeof TEXT]) return `${k}: a string up to ${TEXT[k as keyof typeof TEXT]} chars`;
      out[k] = v.trim();
    } else if ((LISTS as readonly string[]).includes(k)) {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return `${k}: an array of strings`;
      out[k] = v.map((x: string) => (k === "tags" ? x.toLowerCase() : x).trim()).filter(Boolean);
    } else if (k === "porn") {
      if (typeof v !== "boolean") return "porn: a boolean";
      out[k] = v;
    } else if (k === "saved_at") {
      if (v !== null && !Number.isInteger(v)) return "saved_at: unix seconds or null";
      out[k] = v;
    } else return `unknown field: ${k}`;
  }
  if (!Object.keys(out).length) return "no fields to change";
  if (out.title === "") return "title: must not be empty";
  return out as MemeEdit;
}

/** Fields the AI writes (saveDescription): before the meme is ready they wait in `edits`. */
const DESCRIBED = ["title", "ocr_text", "speech_text", "language", "description", "meme_context", "cultural_meaning", "tags", "search_phrases", "porn"];

/**
 * Saves an edit; returns the meme or an error. An unfinished (or failed) meme leaves its processing run: jobs of the
 * old run do nothing (gen), and processing starts again, keeping the edited fields.
 */
export async function editMeme(env: Env, m: Meme, edit: MemeEdit, tries = 3): Promise<Meme | string> {
  const entries = Object.entries(edit).map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : typeof v === "boolean" ? Number(v) : v] as const);
  if (m.status !== "ready") {
    const direct = entries.filter(([k]) => !DESCRIBED.includes(k));
    const described = Object.fromEntries(entries.filter(([k]) => DESCRIBED.includes(k)));
    const row = await env.DB.prepare(
      `UPDATE memes SET ${direct.map(([k]) => `${k} = ?, `).join("")}edits = json_patch(COALESCE(edits, '{}'), ?), title = NULL, status = 'embedding',
        error = NULL, import_id = NULL, gen = gen + 1, updated_at = unixepoch() WHERE id = ? AND gen = ? AND status != 'ready' RETURNING *`,
    )
      .bind(...direct.map(([, v]) => v), JSON.stringify(described), m.id, m.gen)
      .first<Meme>();
    if (row) {
      await env.JOBS.send({ type: "embed", memeId: m.id, gen: row.gen });
      return row;
    }
    // Another edit, or the meme just got ready: try on the new state.
    const fresh = await getMeme(env.DB, m.id);
    return fresh && tries > 1 ? editMeme(env, fresh, edit, tries - 1) : "meme changed, try again";
  }
  await env.DB.prepare(`UPDATE memes SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = unixepoch() WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), m.id)
    .run();
  const updated = (await getMeme(env.DB, m.id))!;
  if (entries.some(([k]) => EMBEDDED.includes(k))) await embedText(env, updated);
  return updated;
}
