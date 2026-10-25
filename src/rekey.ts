import { getMeme } from "./db";
import type { Env } from "./env";
import { extOf, hasExt, KEY_EXTS } from "./media";
import type { Job } from "./queue";

/** One-time move of R2 objects stored before keys had file extensions: copy, update the row, delete. */
export async function rekeyStage(env: Env, memeId: string) {
  const m = await getMeme(env.DB, memeId);
  if (!m) return;
  for (const column of ["r2_file", "r2_preview"] as const) {
    const key = m[column];
    if (!key || hasExt(key)) continue;
    const obj = await env.MEDIA.get(key);
    const preview = column === "r2_preview";
    if (!obj) {
      // Another job already moved it: point at the new key (or forget the key if nothing is there).
      const moved = await findWithExt(env, preview ? `${key.replace(/\.preview$/, "")}.preview` : key);
      await setKey(env, m.id, column, key, moved);
      continue;
    }
    const mime = obj.httpMetadata?.contentType ?? (preview ? "image/jpeg" : (m.mime ?? "application/octet-stream"));
    const newKey = preview ? `${key.replace(/\.preview$/, "")}.preview.jpg` : `${key}.${extOf(mime)}`;
    await env.MEDIA.put(newKey, await obj.arrayBuffer(), { httpMetadata: { contentType: mime } });
    await setKey(env, m.id, column, key, newKey);
    await env.MEDIA.delete(key);
    m[column] = newKey;
  }
}

/** Only replaces the key this job read, so concurrent jobs cannot overwrite each other's result. */
const setKey = (env: Env, id: string, column: "r2_file" | "r2_preview", from: string, to: string | null) =>
  env.DB.prepare(`UPDATE memes SET ${column} = ? WHERE id = ? AND ${column} = ?`).bind(to, id, from).run();

async function findWithExt(env: Env, base: string) {
  for (const ext of KEY_EXTS) if (await env.MEDIA.head(`${base}.${ext}`)) return `${base}.${ext}`;
  return null;
}

/**
 * Relinks R2 objects of memes that lost their key (stored files of "r2:<sha256>" memes, and their
 * previews) by looking them up under the known key layouts. Returns how many keys were restored.
 */
export async function recoverLostKeys(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, kind, file_unique_id, r2_file, r2_preview FROM memes WHERE file_unique_id LIKE 'r2:%' AND (r2_file IS NULL OR (kind != 'photo' AND r2_preview IS NULL))",
  ).all<{ id: string; user_id: number; kind: string; file_unique_id: string; r2_file: string | null; r2_preview: string | null }>();
  let restored = 0;
  for (const m of results) {
    const sha = m.file_unique_id.slice(3);
    const bases = [`r2/${sha}`, `u/${m.user_id}/${sha}`];
    if (!m.r2_file) {
      for (const base of bases) {
        const key = await findWithExt(env, base);
        if (key) {
          await env.DB.prepare("UPDATE memes SET r2_file = ? WHERE id = ? AND r2_file IS NULL").bind(key, m.id).run();
          restored++;
          break;
        }
      }
    }
    if (m.kind !== "photo" && !m.r2_preview) {
      for (const base of [`r2p/${sha}.preview.jpg`, `u/${m.user_id}/${sha}.preview.jpg`]) {
        if (await env.MEDIA.head(base)) {
          await env.DB.prepare("UPDATE memes SET r2_preview = ? WHERE id = ? AND r2_preview IS NULL").bind(base, m.id).run();
          restored++;
          break;
        }
      }
    }
  }
  return restored;
}

const noExt = (column: string) => `(${column} != '' AND NOT (${KEY_EXTS.map((e) => `${column} LIKE '%.${e}'`).join(" OR ")}))`;

export const REKEY_WHERE = `${noExt("r2_file")} OR ${noExt("r2_preview")}`;

/** Cron: queue re-key jobs until every key has an extension (500 per run). */
export async function queueRekey(env: Env, limit = 500) {
  const { results } = await env.DB.prepare(`SELECT id FROM memes WHERE ${REKEY_WHERE} LIMIT ?`).bind(limit).all<{ id: string }>();
  const jobs = results.map((r): { body: Job } => ({ body: { type: "rekey", memeId: r.id } }));
  for (let i = 0; i < jobs.length; i += 100) await env.JOBS.sendBatch(jobs.slice(i, i + 100));
  return jobs.length;
}
