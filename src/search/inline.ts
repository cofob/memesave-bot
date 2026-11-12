import type { Ctx } from "../bot";
import { normQuery, sha256hex } from "../cache";
import { INLINE_CACHE_SECONDS, INLINE_LIMIT } from "../config";
import { loadMemes, recentMemes, visible, type Meme } from "../db";
import type { Env } from "../env";
import { tmpKey } from "../media";
import { toInlineResult } from "./deliver";
import { fastSearch } from "./fast";
import { needUpload } from "./tgupload";
import { canUseAi, type Gate } from "../billing";
import { t } from "../i18n";

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
  const gate: Gate = query.length < 2 ? { ok: true } : await canUseAi(env.DB, ctx.user);
  if (!gate.ok) {
    const [text, start] = gate.reason === "subscribe" ? ["bill_btn_subscribe", "subscribe"] as const : ["bill_btn_topup", "topup"] as const;
    return ctx.answerInlineQuery([], { cache_time: 30, is_personal: true, button: { text: t(ctx.lang, text), start_parameter: start } });
  }
  const chat = ctx.inlineQuery!.chat_type; // no porn outside the chat with the bot and private chats
  const user = chat === "sender" || chat === "private" ? ctx.user : { ...ctx.user, hide_porn: 1 };
  const memes = visible(user, query.length < 2 ? await recentMemes(env.DB, ctx.user.id, INLINE_LIMIT) : await cachedFastSearch(env, ctx.user.id, query));
  const missing = needUpload(memes);
  if (missing.length) await env.UPLOADS.send({ userId: ctx.user.id, memeIds: missing }).catch(console.warn);
  const results = (await Promise.all(memes.map((m) => toInlineResult(env, m)))).filter((r) => r !== null);
  await ctx.answerInlineQuery(results, { cache_time: 30, is_personal: true });
}
