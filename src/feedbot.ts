import { GrammyError, type Api, type Composer } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { Ctx } from "./bot";
import { albumSizes, type User } from "./db";
import type { Env } from "./env";
import { FEED_MODES, feedMode, feedPage, markSeen, startSeed, type FeedMeme, type FeedMode } from "./feed";
import { editMeme, sendMeme } from "./search/deliver";
import { EMOJI, esc, t, type Key, type Lang } from "./i18n";

// Callback data: f:<mode code>:<seed base36>:<offset>. A negative offset: the "time" mode above its point (newer memes).
const CODES: Record<FeedMode, string> = { new: "n", old: "o", random: "r", favorites: "f", forgotten: "g", time: "t", unseen: "u" };
const BY_CODE = Object.fromEntries(Object.entries(CODES).map(([mode, code]) => [code, mode as FeedMode]));
const data = (mode: FeedMode, seed: number, offset: number) => `f:${CODES[mode]}:${seed.toString(36)}:${offset}`;

export function feedKeyboard(env: Env, lang: Lang, mode: FeedMode, seed: number, offset: number, more: boolean, back: boolean): InlineKeyboardMarkup {
  const nav = [
    ...(back ? [{ text: "◀", callback_data: data(mode, seed, offset - 1) }] : []),
    ...(more ? [{ text: "▶", callback_data: data(mode, seed, offset + 1) }] : []),
  ];
  const button = (m: FeedMode) => ({
    text: t(lang, `feed_mode_${m}` as Key),
    callback_data: data(m, startSeed(m), 0),
    ...(m === mode ? { icon_custom_emoji_id: EMOJI.done[0] } : {}),
  });
  const app = { text: t(lang, "app_button"), web_app: { url: `${env.PUBLIC_URL.replace(/\/$/, "")}/?feed=${mode}` } };
  return { inline_keyboard: [nav, FEED_MODES.slice(0, 4).map(button), FEED_MODES.slice(4).map(button), [app]].filter((row) => row.length) };
}

export function feedCaption(lang: Lang, m: FeedMeme, offset: number, album?: number) {
  return [
    m.title ? `<b>${esc(m.title)}</b>` : null,
    `${offset >= 0 ? `#${offset + 1} · ` : ""}${new Date(m.date * 1000).toLocaleDateString(lang, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`,
    m.uses ? t(lang, "feed_uses", { n: m.uses }) : null,
    album && album > 1 ? t(lang, "feed_album", { n: album }) : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Shows the feed meme at `offset`: a new message, or the media of `messageId` replaced. False when there is none. */
export async function showFeed(env: Env, api: Api, chatId: number, user: Pick<User, "id" | "hide_porn">, lang: Lang, mode: FeedMode, seed: number, offset: number, messageId?: number) {
  // Below 0 only the "time" mode has memes: the newer ones, nearest first.
  const at = async (i: number) =>
    i >= 0 || mode === "time" ? (await feedPage(env.DB, user.id, { mode, seed, offset: i < 0 ? -i - 1 : i, limit: 1, newer: i < 0, hidePorn: !!user.hide_porn })).memes[0] : undefined;
  const m = await at(offset);
  if (!m) return false;
  const [more, back] = [!!(await at(offset + 1)), offset > 0 || !!(await at(offset - 1))];
  const other = {
    caption: feedCaption(lang, m, offset, (await albumSizes(env.DB, [m.id])).get(m.id)),
    parse_mode: "HTML" as const,
    reply_markup: feedKeyboard(env, lang, mode, seed, offset, more, back),
  };
  try {
    await (messageId ? editMeme(env, api, chatId, messageId, m, other) : sendMeme(env, api, chatId, m, other));
  } catch (e) {
    if (!(e instanceof GrammyError && e.description.includes("not modified"))) throw e; // the same meme tapped again
  }
  await markSeen(env.DB, user.id, [m.id]);
  return true;
}

export function registerFeed<C extends Ctx>(bot: Composer<C>, env: Env) {
  bot.command("feed", async (ctx) => {
    const mode = feedMode(ctx.match.trim()) ?? "new";
    if (!(await showFeed(env, ctx.api, ctx.chat.id, ctx.user, ctx.lang, mode, startSeed(mode), 0))) await ctx.reply(t(ctx.lang, "feed_empty"));
  });
  bot.callbackQuery(/^f:([norfgtu]):([0-9a-z]+):(-?\d+)$/, async (ctx) => {
    const [, code, seed, offset] = ctx.match;
    const msg = ctx.callbackQuery.message;
    const shown = !!msg && (await showFeed(env, ctx.api, msg.chat.id, ctx.user, ctx.lang, BY_CODE[code], parseInt(seed, 36), Number(offset), msg.message_id));
    await ctx.answerCallbackQuery(shown ? undefined : t(ctx.lang, "feed_end"));
  });
}
