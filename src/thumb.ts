import { Container } from "@cloudflare/containers";
import { getMeme } from "./db";
import type { Env } from "./env";
import { previewKey } from "./media";

/** ffmpeg service (thumb/): one instance per user, so a bad file cannot affect other users; it stops after 1 idle minute. */
export class Thumbnailer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "1m";
}

export interface Thumb {
  jpeg: ArrayBuffer;
  width: number;
  height: number;
  duration: number;
}

/** A preview frame of the video and its size. */
export async function thumbnail(env: Env, userId: number, video: Uint8Array): Promise<Thumb> {
  const res = await env.THUMB.get(env.THUMB.idFromName(`u${userId}`)).fetch("http://thumb/", { method: "POST", body: video });
  if (!res.ok) throw new Error(`thumbnail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const num = (h: string) => Math.round(Number(res.headers.get(h))) || 0;
  return { jpeg: await res.arrayBuffer(), width: num("X-Width"), height: num("X-Height"), duration: num("X-Duration") };
}

/**
 * Queue job of a link import without a preview (all instances were busy): makes it from the R2 copy, then
 * starts stage 1. The queue retries a failure; after the last attempt the meme goes on without a preview.
 */
export async function thumbStage(env: Env, memeId: string) {
  const m = await getMeme(env.DB, memeId);
  if (!m) return;
  const obj = !m.r2_preview && m.r2_file ? await env.MEDIA.get(m.r2_file) : null;
  if (obj) {
    const { jpeg, width, height, duration } = await thumbnail(env, m.user_id, new Uint8Array(await obj.arrayBuffer()));
    const key = previewKey(m.r2_file!.replace(/\.[^.]+$/, ""));
    await env.MEDIA.put(key, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
    await env.DB.prepare("UPDATE memes SET r2_preview = ?, width = ?, height = ?, duration = ? WHERE id = ?").bind(key, width, height, duration, memeId).run();
  }
  await env.JOBS.send({ type: "embed", memeId });
}
