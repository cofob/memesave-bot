import { Container } from "@cloudflare/containers";
import type { Env } from "./env";

/** ffmpeg service (thumb/): one instance, reused while busy; it stops after 5 idle minutes (scale to zero). */
export class Thumbnailer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
}

export interface Thumb {
  jpeg: ArrayBuffer;
  width: number;
  height: number;
  duration: number;
}

/** A preview frame of the video and its size. */
export async function thumbnail(env: Env, video: Uint8Array): Promise<Thumb> {
  const res = await env.THUMB.get(env.THUMB.idFromName("ffmpeg")).fetch("http://thumb/", { method: "POST", body: video });
  if (!res.ok) throw new Error(`thumbnail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const num = (h: string) => Math.round(Number(res.headers.get(h))) || 0;
  return { jpeg: await res.arrayBuffer(), width: num("X-Width"), height: num("X-Height"), duration: num("X-Duration") };
}
