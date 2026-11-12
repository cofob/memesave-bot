import type { Composer } from "grammy";
import type { Ctx } from "./bot";
import { utc } from "./commands";
import { connectE621, disconnectE621, e621Status, LISTS, setE621Lists, setE621Pools, syncE621, type Lists } from "./e621";
import type { Env } from "./env";
import { EMOJI, esc, t, type Key, type Lang } from "./i18n";
import { startGallery } from "./ingest/gallery";
import { E621Error } from "./ingest/sources/e621";
import { allowAi } from "./billingbot";

const html = { parse_mode: "HTML" } as const;

/** Status text and buttons of a connected account (the current sync mode is marked). */
async function card(env: Env, userId: number, lang: Lang) {
  const st = await e621Status(env.DB, userId);
  if (!st.connected) return { text: t(lang, "e621_help"), reply_markup: undefined };
  const text =
    t(lang, "e621_status", { user: esc(st.username!), state: t(lang, st.backfill_done ? "e621_idle" : "e621_running"), n: st.imported!, date: utc(st.last_sync!) }) +
    (st.error ? t(lang, "e621_error", { error: esc(st.error) }) : "");
  const mode = (lists: Lists) => ({
    text: t(lang, `e621_btn_${lists}` as Key),
    callback_data: `e621:lists:${lists}`,
    ...(st.lists === lists ? { icon_custom_emoji_id: EMOJI.done[0] } : {}),
  });
  const row = [{ text: t(lang, "e621_btn_sync"), callback_data: "e621:sync" }, { text: t(lang, "e621_btn_off"), callback_data: "e621:off" }];
  const pools = { text: t(lang, st.pools ? "e621_btn_pools_on" : "e621_btn_pools_off"), callback_data: `e621:pools:${st.pools ? 0 : 1}` };
  return { text, reply_markup: { inline_keyboard: [LISTS.map(mode), [pools], row] } };
}

export function registerE621<C extends Ctx>(bot: Composer<C>, env: Env) {
  const show = async (ctx: C) => {
    const { text, reply_markup } = await card(env, ctx.user.id, ctx.lang);
    await ctx.editMessageText(text, { ...html, reply_markup }).catch(() => {});
  };

  bot.command("e621", async (ctx) => {
    const [username, key] = ctx.match.trim().split(/\s+/);
    if (!key) {
      const { text, reply_markup } = await card(env, ctx.user.id, ctx.lang);
      return ctx.reply(text, { ...html, reply_markup });
    }
    await ctx.deleteMessage().catch(() => {}); // the key must not stay in the chat
    if (!(await allowAi(env, ctx))) return;
    try {
      await connectE621(env, ctx.user.id, username, key);
    } catch (e) {
      if (!(e instanceof E621Error && (e.status === 401 || e.status === 403))) throw e;
      return ctx.reply(t(ctx.lang, "e621_bad"), html);
    }
    await ctx.reply(t(ctx.lang, "e621_connected", { user: esc(username) }), html);
    const { text, reply_markup } = await card(env, ctx.user.id, ctx.lang);
    await ctx.reply(text, { ...html, reply_markup });
  });

  bot.callbackQuery(/^e621:lists:(fav|up|both)$/, async (ctx) => {
    await setE621Lists(env, ctx.user.id, ctx.match[1] as Lists);
    await ctx.answerCallbackQuery(t(ctx.lang, "mode_saved"));
    await show(ctx);
  });

  bot.callbackQuery(/^e621:pools:([01])$/, async (ctx) => {
    await setE621Pools(env.DB, ctx.user.id, ctx.match[1] === "1");
    await ctx.answerCallbackQuery(t(ctx.lang, "mode_saved"));
    await show(ctx);
  });

  bot.callbackQuery("e621:sync", async (ctx) => {
    await ctx.answerCallbackQuery(t(ctx.lang, (await syncE621(env, ctx.user.id)) ? "e621_sync_started" : "e621_sync_busy"));
    await show(ctx);
  });

  bot.callbackQuery(/^e621:pool:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery(t(ctx.lang, "e621_pool_started"));
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await startGallery(env, ctx.user.id, `https://e621.net/pools/${ctx.match[1]}`, "bot", ctx.chat!.id);
  });

  bot.callbackQuery("e621:off", async (ctx) => {
    await disconnectE621(env.DB, ctx.user.id);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t(ctx.lang, "e621_off"), html).catch(() => {});
  });
}
