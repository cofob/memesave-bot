import type { Lang } from "./i18n";

export type Role = "admin" | "user";
export type Kind = "photo" | "video" | "animation";

export interface User {
  id: number;
  username: string | null;
  role: Role;
  lang: string | null;
  search_mode: "advanced" | "fast";
  total_cost: number;
  openrouter_key: string | null;
}

export interface Meme {
  id: string;
  user_id: number;
  kind: Kind;
  file_id: string;
  file_unique_id: string;
  preview_file_id: string | null;
  preview_unique_id: string | null;
  mime: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  caption: string | null;
  source: string | null;
  status: "embedding" | "describing" | "ready" | "failed";
  status_msg_id: number | null;
  title: string | null;
  description: string | null;
  ocr_text: string | null;
  speech_text: string | null;
  language: string | null;
  meme_context: string | null;
  cultural_meaning: string | null;
  tags: string | null;
  search_phrases: string | null;
  import_id: string | null;
  sha256: string | null;
  created_at: number;
}

export const userLang = async (db: D1Database, id: number): Promise<Lang> =>
  (await db.prepare("SELECT lang FROM users WHERE id = ?").bind(id).first<string>("lang")) === "ru" ? "ru" : "en";

export const getUser = (db: D1Database, id: number) =>
  db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();

export const getMeme = (db: D1Database, id: string) =>
  db.prepare("SELECT * FROM memes WHERE id = ?").bind(id).first<Meme>();

export const setStatus = (db: D1Database, id: string, status: Meme["status"], error: string | null = null) =>
  db.prepare("UPDATE memes SET status = ?, error = ?, updated_at = unixepoch() WHERE id = ?").bind(status, error, id).run();

/** Loads memes by id, keeping the order of `ids`. */
export async function loadMemes(db: D1Database, ids: string[]): Promise<Meme[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare(`SELECT * FROM memes WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<Meme>();
  const byId = new Map(results.map((m) => [m.id, m]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export const recentMemes = async (db: D1Database, userId: number, limit: number) =>
  (
    await db
      .prepare("SELECT * FROM memes WHERE user_id = ? AND status != 'failed' ORDER BY created_at DESC LIMIT ?")
      .bind(userId, limit)
      .all<Meme>()
  ).results;

export async function deleteMeme(env: { DB: D1Database; VECTORS: Vectorize; MEDIA: R2Bucket }, id: string) {
  await env.VECTORS.deleteByIds([`${id}:i`, `${id}:t`]);
  const row = await env.DB.prepare("DELETE FROM memes WHERE id = ? RETURNING file_unique_id, preview_unique_id")
    .bind(id)
    .first<{ file_unique_id: string; preview_unique_id: string | null }>();
  // Imported memes that were never sent keep their bytes in MEDIA.
  const stored = [row?.file_unique_id, row?.preview_unique_id].filter((u): u is string => !!u && /^r2p?:/.test(u));
  if (stored.length) await env.MEDIA.delete(stored.map((u) => u.replace(":", "/")));
}
