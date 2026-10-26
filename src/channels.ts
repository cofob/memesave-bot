import { GrammyError, type Api, type Composer } from "grammy";
import type { ChatMemberUpdated, InlineKeyboardButton } from "grammy/types";
import { botApi } from "./botapi";
import type { Ctx } from "./bot";
import { loadMemes, userLang, type Meme } from "./db";
import type { Env } from "./env";
import { esc, t, type Lang } from "./i18n";
import { sendAlbum } from "./search/deliver";

// Auto-posting: each message with memes (a single meme or a media group) is saved as a post; once all its memes
// are processed, the bot posts them to the owner's channels, an album as an album.

export interface Channel {
  chat_id: number;
  user_id: number;
  title: string | null;
  username: string | null;
  enabled: number;
  caption: string;
}

interface Post {
  id: string;
  user_id: number;
  media_group_id: string | null;
  caption: string | null;
  status: string;
  updated_at: number;
}

export const ALBUM_WAIT = 5; // seconds without new album items before posting

/** Adds a meme to its post: one post per media group, a new post for a single message. */
export async function addToPost(db: D1Database, userId: number, p: { memeId: string; mediaGroupId?: string | null; caption?: string | null; position?: number }) {
  const postId = await db
    .prepare(
      `INSERT INTO posts (id, user_id, media_group_id, caption) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, media_group_id) DO UPDATE SET caption = COALESCE(posts.caption, excluded.caption), updated_at = unixepoch()
       RETURNING id`,
    )
    .bind(crypto.randomUUID().replaceAll("-", ""), userId, p.mediaGroupId ?? null, p.caption || null)
    .first<string>("id");
  await db.prepare("INSERT INTO post_items (post_id, meme_id, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(postId, p.memeId, p.position ?? 0)
    .run();
  return postId!;
}

/** Photos of the meme's media group in album order (with the album's last change); empty without a group. */
/** All memes of the media group of `memeId` in album order (its newest one, when a saved file came again in another album); empty when it did not come in an album. */
export async function albumMemes(db: D1Database, memeId: string) {
  const { results } = await db
    .prepare(
      `SELECT m.*, p.updated_at AS album_updated FROM post_items i JOIN posts p ON p.id = i.post_id
       JOIN post_items a ON a.post_id = p.id JOIN memes m ON m.id = a.meme_id
       WHERE i.meme_id = ? AND p.media_group_id IS NOT NULL
         AND p.id = (SELECT q.id FROM post_items j JOIN posts q ON q.id = j.post_id WHERE j.meme_id = i.meme_id AND q.media_group_id IS NOT NULL ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1)
       ORDER BY a.position`,
    )
    .bind(memeId)
    .all<Meme & { album_updated: number }>();
  return results;
}

export const albumPhotos = async (db: D1Database, memeId: string) => (await albumMemes(db, memeId)).filter((m) => m.kind === "photo");

/** After a meme is processed (ready or failed): check its pending posts. */
export async function queuePosts(env: Env, memeId: string) {
  const { results } = await env.DB.prepare(
    "SELECT p.id FROM posts p JOIN post_items i ON i.post_id = p.id WHERE i.meme_id = ? AND p.status = 'pending'",
  )
    .bind(memeId)
    .all<{ id: string }>();
  for (const r of results) await env.JOBS.send({ type: "post", postId: r.id }, { delaySeconds: ALBUM_WAIT });
}

/** Caption from the channel template: {caption}, {title}, {tags}, {source}. Plain text, at most 1024 characters. */
export function renderCaption(template: string, post: Pick<Post, "caption">, memes: Meme[]) {
  const tags = [...new Set(memes.flatMap((m) => m.tags?.split("\n") ?? []))]
    .filter(Boolean)
    .slice(0, 8)
    .map((x) => "#" + x.replace(/[^\p{L}\p{N}_]+/gu, "_"))
    .join(" ");
  const values: Record<string, string> = { caption: post.caption ?? "", title: memes[0]?.title ?? "", tags, source: memes[0]?.source ?? "" };
  return template
    .replace(/\{(caption|title|tags|source)\}/g, (_, k: string) => values[k])
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, all) => l || (i > 0 && all[i - 1]))
    .join("\n")
    .trim()
    .slice(0, 1024);
}

/** The bot cannot post there any more: kicked, no rights, or the channel is gone. */
const lostChannel = (e: unknown) =>
  e instanceof GrammyError && (e.error_code === 403 || /chat not found|not enough rights|CHAT_WRITE_FORBIDDEN|have no rights/i.test(e.description));

async function notifyOwner(env: Env, userId: number, text: (lang: Lang) => string, buttons: (lang: Lang) => InlineKeyboardButton[][] = () => []) {
  const lang = await userLang(env.DB, userId);
  await botApi(env.BOT_TOKEN)
    .sendMessage(userId, text(lang), { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons(lang) } })
    .catch(() => {}); // the user may not have started the bot
}

/** Queue job: posts once all memes of the post are processed and the album is complete. */
export async function postJob(env: Env, postId: string) {
  const db = env.DB;
  const post = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(postId).first<Post>();
  if (post?.status !== "pending") return;
  const { results: items } = await db
    .prepare("SELECT m.id, m.status FROM post_items i JOIN memes m ON m.id = i.meme_id WHERE i.post_id = ? ORDER BY i.position")
    .bind(postId)
    .all<{ id: string; status: string }>();
  if (items.some((i) => i.status !== "ready" && i.status !== "failed")) return; // the last one queues this again
  if (Math.floor(Date.now() / 1000) - post.updated_at < ALBUM_WAIT) {
    await env.JOBS.send({ type: "post", postId }, { delaySeconds: ALBUM_WAIT });
    return;
  }
  const { results: channels } = await db.prepare("SELECT * FROM channels WHERE user_id = ? AND enabled = 1").bind(post.user_id).all<Channel>();
  if (!items.length || !channels.length) {
    await db.prepare("UPDATE posts SET status = 'skipped', updated_at = unixepoch() WHERE id = ? AND status = 'pending'").bind(postId).run();
    return;
  }
  const claimed = await db.prepare("UPDATE posts SET status = 'posting' WHERE id = ? AND status = 'pending' RETURNING id").bind(postId).first();
  if (!claimed) return;

  const order = items.map((i) => i.id);
  const memes = (await loadMemes(db, order)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const api = botApi(env.BOT_TOKEN);
  const errors: string[] = [];
  for (const ch of channels) {
    try {
      await sendAlbum(env, api, ch.chat_id, memes, {}, renderCaption(ch.caption, post, memes) || undefined);
    } catch (e) {
      // No retry: a partly sent album must not be posted twice.
      errors.push(`${ch.chat_id}: ${String(e).slice(0, 200)}`);
      if (lostChannel(e)) {
        await db.prepare("UPDATE channels SET enabled = 0 WHERE chat_id = ?").bind(ch.chat_id).run();
        await notifyOwner(env, ch.user_id, (lang) => t(lang, "channel_lost", { title: esc(ch.title ?? String(ch.chat_id)) }));
      }
    }
  }
  await db.prepare("UPDATE posts SET status = 'posted', error = ?, updated_at = unixepoch() WHERE id = ?")
    .bind(errors.length ? errors.join("\n").slice(0, 1000) : null, postId)
    .run();
}

/** my_chat_member in a channel: admin with the right to post links it to the user who gave the rights; otherwise unlinks it. */
export async function onBotMembership(env: Env, update: ChatMemberUpdated) {
  const { chat, from, new_chat_member: member } = update;
  if (chat.type !== "channel") return;
  const title = esc(chat.title);
  if (member.status === "administrator" && member.can_post_messages) {
    await env.DB.prepare(
      `INSERT INTO channels (chat_id, user_id, title, username) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, title = excluded.title, username = excluded.username, enabled = 1`,
    )
      .bind(chat.id, from.id, chat.title, chat.username ?? null)
      .run();
    await notifyOwner(
      env,
      from.id,
      (lang) => t(lang, "channel_linked", { title }),
      (lang) => [[{ text: t(lang, "channel_btn_caption"), callback_data: `ch:c:${chat.id}` }]],
    );
    return;
  }
  const removed = await env.DB.prepare("DELETE FROM channels WHERE chat_id = ? RETURNING user_id").bind(chat.id).first<number>("user_id");
  if (removed) await notifyOwner(env, removed, (lang) => t(lang, "channel_unlinked", { title }));
}

const getChannel = (db: D1Database, userId: number, chatId: number) =>
  db.prepare("SELECT * FROM channels WHERE chat_id = ? AND user_id = ?").bind(chatId, userId).first<Channel>();

export const listChannels = async (db: D1Database, userId: number) =>
  (await db.prepare("SELECT * FROM channels WHERE user_id = ? ORDER BY created_at").bind(userId).all<Channel>()).results;

/** Telegram link that opens the channel picker and asks for the right to post. */
export const addChannelUrl = (botUsername: string) => `https://t.me/${botUsername}?startchannel&admin=post_messages`;

/** Changes a channel of the user; false when it is not theirs. */
export async function updateChannel(db: D1Database, userId: number, chatId: number, p: { enabled?: boolean; caption?: string }) {
  const ch = await getChannel(db, userId, chatId);
  if (!ch) return false;
  await db.prepare("UPDATE channels SET enabled = ?, caption = ? WHERE chat_id = ?")
    .bind(p.enabled === undefined ? ch.enabled : p.enabled ? 1 : 0, (p.caption ?? ch.caption).slice(0, 1024), chatId)
    .run();
  return true;
}

/** Unlinks a channel of the user and leaves it. */
export async function removeChannel(env: Env, userId: number, chatId: number) {
  const removed = await env.DB.prepare("DELETE FROM channels WHERE chat_id = ? AND user_id = ? RETURNING chat_id").bind(chatId, userId).first();
  if (removed) await botApi(env.BOT_TOKEN).leaveChat(chatId).catch(() => {});
  return !!removed;
}

async function channelsCard(env: Env, api: Api, userId: number, lang: Lang) {
  const channels = await listChannels(env.DB, userId);
  const me = await api.getMe();
  const rows: InlineKeyboardButton[][] = channels.map((ch) => [
    { text: `${ch.enabled ? "✅" : "⛔"} ${ch.title ?? ch.chat_id}`, callback_data: `ch:t:${ch.chat_id}` },
    { text: t(lang, "channel_btn_caption"), callback_data: `ch:c:${ch.chat_id}` },
    { text: t(lang, "channel_btn_unlink"), callback_data: `ch:d:${ch.chat_id}` },
  ]);
  rows.push([{ text: t(lang, "channel_btn_add"), url: addChannelUrl(me.username) }]);
  return { text: t(lang, channels.length ? "channels" : "channels_none"), reply_markup: { inline_keyboard: rows } };
}

const html = { parse_mode: "HTML" } as const;

/** Reply to the caption prompt: the prompt holds the channel id in <code>. */
export async function captionReply(env: Env, ctx: Ctx): Promise<boolean> {
  const prompt = ctx.msg?.reply_to_message;
  if (prompt?.from?.id !== ctx.me.id || !prompt.text?.includes("{caption}")) return false;
  const id = prompt.text.match(/-100\d+/)?.[0];
  const text = ctx.msg!.text!.trim();
  if (!id || !(await updateChannel(env.DB, ctx.user.id, Number(id), { caption: text === "-" ? "" : text }))) return false;
  await ctx.reply(t(ctx.lang, "channel_caption_saved"), html);
  return true;
}

export function registerChannels<C extends Ctx>(bot: Composer<C>, env: Env) {
  bot.command("channels", async (ctx) => {
    const card = await channelsCard(env, ctx.api, ctx.user.id, ctx.lang);
    await ctx.reply(card.text, { ...html, reply_markup: card.reply_markup });
  });

  bot.callbackQuery(/^ch:([tcd]):(-?\d+)$/, async (ctx) => {
    const [, action, id] = ctx.match;
    const chatId = Number(id);
    const ch = await getChannel(env.DB, ctx.user.id, chatId);
    if (!ch) return ctx.answerCallbackQuery(t(ctx.lang, "channel_gone"));
    await ctx.answerCallbackQuery();
    if (action === "c") {
      const text = t(ctx.lang, "channel_caption_prompt", { title: esc(ch.title ?? id), id, current: esc(ch.caption || "-") });
      return ctx.reply(text, { ...html, reply_markup: { force_reply: true, input_field_placeholder: "{caption}" } });
    }
    if (action === "t") await updateChannel(env.DB, ctx.user.id, chatId, { enabled: !ch.enabled });
    else await removeChannel(env, ctx.user.id, chatId);
    const card = await channelsCard(env, ctx.api, ctx.user.id, ctx.lang);
    await ctx.editMessageText(card.text, { ...html, reply_markup: card.reply_markup }).catch(() => {});
  });
}
