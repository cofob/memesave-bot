import { GrammyError, type Api, type Composer } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { Ctx } from "./bot";
import { albumSizes, type User } from "./db";
import type { Env } from "./env";
import { FEED_MODES, feedMode, feedPage, markSeen, startSeed, type FeedMeme, type FeedMode } from "./feed";
import { editMeme, sendMeme } from "./search/deliver";
import { EMOJI, esc, t, type Key, type Lang } from "./i18n";
import { ownerOf, pairFeed, pairPage, type PairMode } from "./pairfeed";

// Callback data: f:<mode code>:<seed base36>:<offset>. A negative offset: the "time" mode above its point (newer memes).
const CODES: Record<FeedMode, string> = { new: "n", old: "o", random: "r", favorites: "f", forgotten: "g", time: "t", unseen: "u", porn: "p" };
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

export function feedCaption(lang: Lang, m: FeedMeme, offset: number, album?: number, comic = false) {
  return [
    m.title ? `<b>${esc(m.title)}</b>` : null,
    `${offset >= 0 ? `#${offset + 1} · ` : ""}${new Date(m.date * 1000).toLocaleDateString(lang, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`,
    m.uses ? t(lang, "feed_uses", { n: m.uses }) : null,
    album && album > 1 ? t(lang, comic ? "feed_comic" : "feed_album", { n: album }) : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const isComic = async (db: D1Database, memeId: string) =>
  !!(await db.prepare("SELECT 1 FROM post_items i JOIN posts p ON p.id = i.post_id WHERE i.meme_id = ? AND p.media_group_id IS NOT NULL AND p.layout = 'comic'").bind(memeId).first());

/** Shows the feed meme at `offset`: a new message, or the media of `messageId` replaced. False when there is none. */
export async function showFeed(env: Env, api: Api, chatId: number, user: Pick<User, "id" | "hide_porn">, lang: Lang, mode: FeedMode, seed: number, offset: number, messageId?: number) {
  // Below 0 only the "time" mode has memes: the newer ones, nearest first.
  const at = async (i: number) =>
    i >= 0 || mode === "time" ? (await feedPage(env.DB, user.id, { mode, seed, offset: i < 0 ? -i - 1 : i, limit: 1, newer: i < 0, hidePorn: !!user.hide_porn })).memes[0] : undefined;
  const m = await at(offset);
  if (!m) return false;
  const [more, back] = [!!(await at(offset + 1)), offset > 0 || !!(await at(offset - 1))];
  const other = {
    caption: feedCaption(lang, m, offset, (await albumSizes(env.DB, [m.id])).get(m.id), await isComic(env.DB, m.id)),
    parse_mode: "HTML" as const,
    reply_markup: feedKeyboard(env, lang, mode, seed, offset, more, back),
  };
  await show(env, api, chatId, m, other, messageId);
  await markSeen(env.DB, user.id, [m.id]);
  return true;
}

async function show(env: Env, api: Api, chatId: number, m: FeedMeme, other: Parameters<typeof sendMeme>[4], messageId?: number) {
  try {
    await (messageId ? editMeme(env, api, chatId, messageId, m, other) : sendMeme(env, api, chatId, m, other));
  } catch (e) {
    if (!(e instanceof GrammyError && e.description.includes("not modified"))) throw e; // the same meme tapped again
  }
}

// Pair feed: pf:<pair id>:<mode code>:<seed base36>:<offset>; guess answers: pg:<pair id>:<seed base36>:<offset>:<m|p>.
const PAIR_CODES: Record<PairMode, string> = { mix: "x", theirs: "t", twins: "w", rhymes: "r", foryou: "y", surprise: "s", bridge: "b", guess: "g" };
const BY_PAIR_CODE = Object.fromEntries(Object.entries(PAIR_CODES).map(([mode, code]) => [code, mode as PairMode]));
const pairData = (id: string, mode: PairMode, seed: number, offset: number) => `pf:${id}:${PAIR_CODES[mode]}:${seed.toString(36)}:${offset}`;
/** The first button of a pair feed mode: theirs starts a session (unseen memes first), the others a random order. */
export const pairButton = (id: string, mode: PairMode, text: string) => ({ text, callback_data: pairData(id, mode, startSeed(mode === "theirs" ? "unseen" : "random"), 0) });

/** Shows the pair feed meme at `offset` like showFeed; the caption says whose meme it is, except in the guess game. */
export async function showPairFeed(env: Env, api: Api, chatId: number, user: Pick<User, "id" | "hide_porn">, lang: Lang, pairId: string, mode: PairMode, seed: number, offset: number, messageId?: number) {
  const f = await pairFeed(env, user.id, pairId);
  if (!f?.modes.includes(mode)) return false;
  const {
    memes: [m],
    more,
  } = await pairPage(env, f, mode, { seed, offset, limit: 1, hidePorn: !!user.hide_porn });
  if (!m) return false;
  const nav = [
    ...(offset > 0 ? [{ text: "◀", callback_data: pairData(f.id, mode, seed, offset - 1) }] : []),
    ...(more ? [{ text: "▶", callback_data: pairData(f.id, mode, seed, offset + 1) }] : []),
  ];
  const answer = (o: "m" | "p", text: string) => ({ text, callback_data: `pg:${f.id}:${seed.toString(36)}:${offset}:${o}` });
  const modes = f.modes.map((x) => ({ ...pairButton(f.id, x, t(lang, `pf_mode_${x}` as Key)), ...(x === mode ? { icon_custom_emoji_id: EMOJI.done[0] } : {}) }));
  const app = { text: t(lang, "app_button"), web_app: { url: `${env.PUBLIC_URL.replace(/\/$/, "")}/?pair=${f.id}&feed=${mode}` } };
  const top = mode === "guess" ? [answer("m", t(lang, "pg_mine")), answer("p", t(lang, "pg_partner", { name: f.name }))] : nav;
  const whose = mode === "guess" ? t(lang, "pg_ask") : t(lang, ownerOf(f, m) === "me" ? "pf_mine" : "pf_theirs", { name: esc(f.name) });
  await show(env, api, chatId, m, {
    caption: `${whose}\n${feedCaption(lang, m, offset, (await albumSizes(env.DB, [m.id])).get(m.id))}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [top, modes.slice(0, 4), modes.slice(4), [app]].filter((row) => row.length) },
  }, messageId);
  await markSeen(env.DB, user.id, [m.id], f.users);
  return true;
}

export function registerFeed<C extends Ctx>(bot: Composer<C>, env: Env) {
  bot.command("feed", async (ctx) => {
    const mode = feedMode(ctx.match.trim()) ?? "new";
    if (!(await showFeed(env, ctx.api, ctx.chat.id, ctx.user, ctx.lang, mode, startSeed(mode), 0))) await ctx.reply(t(ctx.lang, "feed_empty"));
  });
  bot.callbackQuery(/^f:([norfgtup]):([0-9a-z]+):(-?\d+)$/, async (ctx) => {
    const [, code, seed, offset] = ctx.match;
    const msg = ctx.callbackQuery.message;
    const shown = !!msg && (await showFeed(env, ctx.api, msg.chat.id, ctx.user, ctx.lang, BY_CODE[code], parseInt(seed, 36), Number(offset), msg.message_id));
    await ctx.answerCallbackQuery(shown ? undefined : t(ctx.lang, "feed_end"));
  });
  bot.callbackQuery(/^pf:([\w-]{12}):([xtwrysbg]):([0-9a-z]+):(\d+)$/, async (ctx) => {
    const [, id, code, seed, offset] = ctx.match;
    const msg = ctx.callbackQuery.message;
    const media = msg && ("photo" in msg || "video" in msg || "animation" in msg) ? msg.message_id : undefined; // else (the /pair card) a new message
    const shown = !!msg && (await showPairFeed(env, ctx.api, msg.chat.id, ctx.user, ctx.lang, id, BY_PAIR_CODE[code], parseInt(seed, 36), Number(offset), media));
    await ctx.answerCallbackQuery(shown ? undefined : t(ctx.lang, "feed_end"));
  });
  bot.callbackQuery(/^pg:([\w-]{12}):([0-9a-z]+):(\d+):([mp])$/, async (ctx) => {
    const [, id, seed36, offset, pick] = ctx.match;
    const [msg, seed] = [ctx.callbackQuery.message, parseInt(seed36, 36)];
    const f = await pairFeed(env, ctx.user.id, id, false);
    const m = f && (await pairPage(env, f, "guess", { seed, offset: Number(offset), limit: 1, hidePorn: !!ctx.user.hide_porn })).memes[0];
    if (!f || !m || !msg) return ctx.answerCallbackQuery(t(ctx.lang, "feed_end"));
    const owner = ownerOf(f, m);
    const verdict = t(ctx.lang, owner === (pick === "m" ? "me" : "partner") ? "pg_right" : owner === "me" ? "pg_wrong_mine" : "pg_wrong", { name: f.name });
    const shown = await showPairFeed(env, ctx.api, msg.chat.id, ctx.user, ctx.lang, id, "guess", seed, Number(offset) + 1, msg.message_id);
    await ctx.answerCallbackQuery(shown ? verdict : `${verdict}\n${t(ctx.lang, "feed_end")}`);
  });
}
