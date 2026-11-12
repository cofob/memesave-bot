import { Bot, type Context } from "grammy";
import { retryOn429 } from "./botapi";
import { registerAdmin } from "./admin";
import { registerE621 } from "./e621bot";
import { registerFeed } from "./feedbot";
import { registerPairs } from "./pairbot";
import { resolveUser } from "./auth";
import { setCommandScope } from "./botcommands";
import { registerCommands } from "./commands";
import { recordUse, type User } from "./db";
import type { Env } from "./env";
import { langOf, t, type Lang } from "./i18n";
import { receiveMedia } from "./ingest/receive";
import { gallerySource, startGallery } from "./ingest/gallery";
import { findLink, importLink } from "./ingest/link";
import { handleInline } from "./search/inline";
import { allowAi, registerBilling, registerPayments } from "./billingbot";
import { captionReply, onBotMembership, registerChannels } from "./channels";
import { pairQuery } from "./pairwidget";
import { statsQuery } from "./statswidget";
import { settingsQuery } from "./settingswidget";
import { answerWidget, type WidgetQuery } from "./widget";

export type Ctx = Context & { user: User; lang: Lang };

export function createBot(env: Env) {
  const bot = new Bot<Ctx>(env.BOT_TOKEN);
  bot.api.config.use(retryOn429());
  const html = { parse_mode: "HTML" } as const;

  // Widget queries (grammy 1.46 does not know them, so ctx.from is unset): routed by the first byte of the data.
  bot.use(async (ctx, next) => {
    const q = (ctx.update as { widget_query?: WidgetQuery }).widget_query;
    if (!q) return next();
    const res = await resolveUser(env, q.from);
    const data = !res ? undefined : q.data[0] === "s" ? await statsQuery(env, ctx.api, q, res.user).catch(console.error) : q.data[0] === "p" ? await pairQuery(env, q, res.user).catch(console.error) : q.data[0] === "c" ? await settingsQuery(env, ctx.api, q, res.user).catch(console.error) : undefined;
    await answerWidget(ctx.api, q.id, data ?? undefined).catch(console.error);
  });

  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    ctx.lang = langOf(ctx.from);
    const res = await resolveUser(env, ctx.from);
    if (!res) {
      if (ctx.inlineQuery) {
        return ctx.answerInlineQuery([], {
          cache_time: 60,
          button: { text: t(ctx.lang, "no_access_short"), start_parameter: "noaccess" },
        });
      }
      if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: t(ctx.lang, "no_access_short"), show_alert: true });
      if (ctx.chat?.type === "private") return ctx.reply(t(ctx.lang, "no_access", { id: ctx.from.id }), html);
      return;
    }
    ctx.user = res.user;
    if (res.created && res.user.role === "admin") {
      await setCommandScope(ctx.api, res.user.id, "admin", ctx.lang).catch(console.error);
    }
    await next();
  });

  bot.on("inline_query", (ctx) => handleInline(ctx, env));
  // Needs inline feedback turned on in BotFather (/setinlinefeedback).
  bot.on("chosen_inline_result", (ctx) => recordUse(env.DB, ctx.user.id, ctx.chosenInlineResult.result_id, "inline"));
  registerPayments(bot, env);
  bot.on("my_chat_member", (ctx) => onBotMembership(env, ctx.myChatMember));

  const pm = bot.chatType("private");
  registerCommands(pm, env);
  registerFeed(pm, env);
  registerAdmin(pm, env);
  registerBilling(pm, env);
  registerChannels(pm, env);
  registerE621(pm, env);
  registerPairs(pm, env);
  pm.on(["message:photo", "message:video", "message:animation"], async (ctx) => (await allowAi(env, ctx)) && receiveMedia(ctx, env));
  pm.on("message:text", async (ctx) => {
    const text = ctx.msg.text.trim();
    if (text.startsWith("/")) return ctx.reply(t(ctx.lang, "unknown_cmd"), html);
    if (await captionReply(env, ctx)) return;
    if (!(await allowAi(env, ctx))) return;
    const link = findLink(text);
    if (link && gallerySource(link)) {
      await ctx.replyWithChatAction("upload_photo").catch(() => {});
      return startGallery(env, ctx.user.id, link, "bot", ctx.chat.id);
    }
    if (link) return importLink(ctx, env, link);
    const placeholder = await ctx.reply(t(ctx.lang, "searching"), html);
    await env.JOBS.send({
      type: "search",
      userId: ctx.user.id,
      messageId: ctx.msg.message_id,
      placeholderId: placeholder.message_id,
      query: text.slice(0, 500),
      lang: ctx.lang,
    });
  });
  pm.on("message", (ctx) => ctx.reply(t(ctx.lang, "unsupported"), html));

  bot.catch((err) => console.error("bot error", err.error));
  return bot;
}
