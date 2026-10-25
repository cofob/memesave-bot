import type { Lang } from "./i18n";

export type Role = "admin" | "user" | "paid";
export type Kind = "photo" | "video" | "animation";

export interface User {
  id: number;
  username: string | null;
  role: Role;
  lang: string | null;
  search_mode: "advanced" | "fast";
  total_cost: number;
  openrouter_key: string | null;
  describe_tier: "max" | "medium";
  plan: "monthly" | "yearly" | null;
  plan_byok: number;
  paid_until: number | null;
  plan_started: number | null;
  balance: number;
  sub_charge_id: string | null;
  sub_state: string | null;
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
  r2_file: string | null; // permanent copy in MEDIA ("" = cannot be downloaded from Telegram)
  r2_preview: string | null;
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

type MemeStores = { DB: D1Database; VECTORS: Vectorize; MEDIA: R2Bucket };

/** Deletes memes with their vectors and R2 files (up to 100 ids: Vectorize and D1 bind limits). */
export async function deleteMemes(env: MemeStores, ids: string[]) {
  if (!ids.length) return;
  await env.VECTORS.deleteByIds(ids.flatMap((id) => [`${id}:i`, `${id}:t`]));
  const { results } = await env.DB.prepare(`DELETE FROM memes WHERE id IN (${ids.map(() => "?").join(",")}) RETURNING r2_file, r2_preview`)
    .bind(...ids)
    .all<{ r2_file: string | null; r2_preview: string | null }>();
  const keys = results.flatMap((r) => [r.r2_file, r.r2_preview]).filter((k): k is string => !!k);
  if (keys.length) await env.MEDIA.delete(keys);
}

export const deleteMeme = (env: MemeStores, id: string) => deleteMemes(env, [id]);
