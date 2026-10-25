import type { Ctx } from "../bot";
import { normQuery, sha256hex } from "../cache";
import { INLINE_CACHE_SECONDS, INLINE_LIMIT } from "../config";
import { loadMemes, recentMemes, type Meme } from "../db";
import type { Env } from "../env";
import { tmpKey } from "../media";
import { toInlineResult } from "./deliver";
import { fastSearch } from "./fast";

/** Fast search with ranked ids cached in R2 for a few minutes (repeated keystrokes cost nothing). */
export async function cachedFastSearch(env: Env, userId: number, query: string): Promise<Meme[]> {
  const key = tmpKey(`i/${userId}/${await sha256hex(normQuery(query))}`);
  const hit = await env.MEDIA.get(key);
  if (hit && Date.now() - hit.uploaded.getTime() < INLINE_CACHE_SECONDS * 1000) {
    return loadMemes(env.DB, await hit.json<string[]>());
  }
  const memes = await fastSearch(env, userId, query, INLINE_LIMIT);
  await env.MEDIA.put(key, JSON.stringify(memes.map((m) => m.id)));
  return memes;
}

export async function handleInline(ctx: Ctx, env: Env) {
  const query = ctx.inlineQuery!.query.trim();
  const memes = query.length < 2 ? await recentMemes(env.DB, ctx.user.id, INLINE_LIMIT) : await cachedFastSearch(env, ctx.user.id, query);
  const results = (await Promise.all(memes.map((m) => toInlineResult(env, m)))).filter((r) => r !== null);
  await ctx.answerInlineQuery(results, { cache_time: 30, is_personal: true });
}
