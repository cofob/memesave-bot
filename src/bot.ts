import { Bot, type Context } from "grammy";
import { retryOn429 } from "./botapi";
import { registerAdmin } from "./admin";
import { resolveUser } from "./auth";
import { setCommandScope } from "./botcommands";
import { registerCommands } from "./commands";
import type { User } from "./db";
import type { Env } from "./env";
import { langOf, t, type Lang } from "./i18n";
import { receiveMedia } from "./ingest/receive";
import { handleInline } from "./search/inline";
import { allowAi, registerBilling, registerPayments } from "./billingbot";

export type Ctx = Context & { user: User; lang: Lang };

export function createBot(env: Env) {
  const bot = new Bot<Ctx>(env.BOT_TOKEN);
  bot.api.config.use(retryOn429());
  const html = { parse_mode: "HTML" } as const;

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
  registerPayments(bot, env);

  const pm = bot.chatType("private");
  registerCommands(pm, env);
  registerAdmin(pm, env);
  registerBilling(pm, env);
  pm.on(["message:photo", "message:video", "message:animation"], async (ctx) => (await allowAi(env, ctx)) && receiveMedia(ctx, env));
  pm.on("message:text", async (ctx) => {
    const text = ctx.msg.text.trim();
    if (text.startsWith("/")) return ctx.reply(t(ctx.lang, "unknown_cmd"), html);
    if (!(await allowAi(env, ctx))) return;
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
