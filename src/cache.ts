import { EMBED_DIMS, MODELS } from "./config";
import type { Env } from "./env";
import { embed } from "./openrouter";
import type { Spend } from "./spend";

export async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const normQuery = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Embeds search queries; cached in R2 so a repeated query costs nothing. */
export async function cachedQueryEmbeddings(env: Env, texts: string[], spend: Spend): Promise<number[][]> {
  const keys = await Promise.all(texts.map((t) => sha256hex(`${MODELS.embed}|${EMBED_DIMS}|${normQuery(t)}`)));
  const out = await Promise.all(
    keys.map(async (k) => {
      const hit = await env.CACHE.get(`q/${k}`);
      return hit ? Array.from(new Float32Array(await hit.arrayBuffer())) : undefined;
    }),
  );
  const miss = out.flatMap((v, i) => (v ? [] : [i]));
  if (miss.length) {
    const vecs = await embed(env, miss.map((i) => texts[i]), "search_query", spend);
    await Promise.all(
      miss.map((i, j) => {
        out[i] = vecs[j];
        return env.CACHE.put(`q/${keys[i]}`, new Float32Array(vecs[j]).buffer);
      }),
    );
  }
  return out as number[][];
}
