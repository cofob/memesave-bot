import type { Message, MessageOrigin } from "grammy/types";
import type { Ctx } from "../bot";
import type { Kind } from "../db";
import type { Env } from "../env";
import { t } from "../i18n";
import { collectingImport } from "../batch";

export interface NewMeme {
  kind: Kind;
  file_id: string;
  file_unique_id: string;
  preview_file_id: string | null;
  preview_unique_id: string | null;
  mime: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
}

export function extractMedia(msg: Message): NewMeme | null {
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    const side = (p: { width: number; height: number }) => Math.abs(Math.max(p.width, p.height) - 640);
    const preview = msg.photo.reduce((a, b) => (side(b) < side(a) ? b : a));
    return {
      kind: "photo",
      file_id: largest.file_id,
      file_unique_id: largest.file_unique_id,
      preview_file_id: preview.file_id,
      preview_unique_id: preview.file_unique_id,
      mime: "image/jpeg",
      file_size: largest.file_size ?? null,
      width: largest.width,
      height: largest.height,
      duration: null,
    };
  }
  const kind = msg.animation ? "animation" : msg.video ? "video" : null;
  const file = msg.animation ?? msg.video;
  if (!kind || !file) return null;
  return {
    kind,
    file_id: file.file_id,
    file_unique_id: file.file_unique_id,
    preview_file_id: file.thumbnail?.file_id ?? null,
    preview_unique_id: file.thumbnail?.file_unique_id ?? null,
    mime: file.mime_type ?? null,
    file_size: file.file_size ?? null,
    width: file.width,
    height: file.height,
    duration: file.duration,
  };
}

export function describeOrigin(o: MessageOrigin | undefined): string | null {
  switch (o?.type) {
    case "channel":
      return o.chat.username ? `${o.chat.title} (https://t.me/${o.chat.username}/${o.message_id})` : o.chat.title;
    case "chat":
      return o.sender_chat.title ?? null;
    case "user":
      return [o.sender_user.first_name, o.sender_user.last_name, o.sender_user.username && `@${o.sender_user.username}`]
        .filter(Boolean)
        .join(" ");
    case "hidden_user":
      return o.sender_user_name;
    default:
      return null;
  }
}

export type MemeRow = NewMeme & {
  caption: string | null;
  source: string | null;
  import_id: string | null;
  sha256?: string | null;
  r2_file?: string | null;
  r2_preview?: string | null;
};

/** Inserts a meme; returns its id, or null when the user already has this file. */
export const insertMeme = (db: D1Database, userId: number, m: MemeRow) =>
  db
    .prepare(
      `INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, preview_file_id, preview_unique_id, mime, file_size,
        width, height, duration, caption, source, import_id, sha256, r2_file, r2_preview)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, file_unique_id) DO NOTHING RETURNING id`,
    )
    .bind(
      crypto.randomUUID().replaceAll("-", ""),
      userId,
      m.kind,
      m.file_id,
      m.file_unique_id,
      m.preview_file_id,
      m.preview_unique_id,
      m.mime,
      m.file_size,
      m.width,
      m.height,
      m.duration,
      m.caption,
      m.source,
      m.import_id,
      m.sha256 ?? null,
      m.r2_file ?? null,
      m.r2_preview ?? null,
    )
    .first<string>("id");

/** Saves a forwarded meme row and starts stage 1. */
export async function receiveMedia(ctx: Ctx, env: Env) {
  const msg = ctx.msg!;
  const media = extractMedia(msg);
  if (!media) return;
  const db = env.DB;
  const html = { parse_mode: "HTML" } as const;
  // Batch mode collects photos only; videos and GIFs always use the normal pipeline.
  const importId = media.kind === "photo" ? await collectingImport(db, ctx.user.id) : null;

  let memeId = await insertMeme(db, ctx.user.id, {
    ...media,
    caption: msg.caption ?? null,
    source: describeOrigin(msg.forward_origin),
    import_id: importId,
  });

  if (memeId && importId) {
    await ctx.react("👌").catch(() => {});
    await env.JOBS.send({ type: "embed", memeId });
    return;
  }

  if (!memeId) {
    const old = await db
      .prepare("SELECT id, status FROM memes WHERE user_id = ? AND file_unique_id = ?")
      .bind(ctx.user.id, media.file_unique_id)
      .first<{ id: string; status: string }>();
    if (old!.status !== "failed") return ctx.reply(t(ctx.lang, old!.status === "ready" ? "already_saved" : "processing"), html);
    memeId = old!.id;
  }

  const status = await ctx.reply(t(ctx.lang, "saving"), { ...html, reply_parameters: { message_id: msg.message_id } });
  await db
    .prepare("UPDATE memes SET status = 'embedding', error = NULL, status_msg_id = ?, updated_at = unixepoch() WHERE id = ?")
    .bind(status.message_id, memeId)
    .run();
  await env.JOBS.send({ type: "embed", memeId });
}
