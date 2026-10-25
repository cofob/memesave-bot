import { InputFile, InputMediaBuilder } from "grammy";
import type { Ctx } from "../bot";
import type { Kind } from "../db";
import type { Env } from "../env";
import { t } from "../i18n";
import { extOf } from "../media";
import { receiveMedia } from "./receive";

// Media by link: any service of the cobalt API (COBALT_URL). TikTok is first downloaded directly the way cobalt
// (github.com/imputnet/cobalt) does it: the post page embeds its data as JSON, and the media CDN wants the page cookies.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const ALBUM_MAX = 10; // Telegram media group limit
const UPLOAD_MAX = 50 << 20; // Bot API upload limit

export const findLink = (text: string) => text.match(/https?:\/\/\S+/i)?.[0] ?? null;
const isTiktok = (url: string) => /^https?:\/\/(?:[\w-]+\.)?tiktok\.com\//i.test(url);

const postIdOf = (url: string) => url.match(/\/(?:video|photo)\/(\d{1,21})|\/v\/(\d{1,21})\.html/)?.slice(1).find(Boolean) ?? null;

/** Post id of a full link, or of a short link (vm.tiktok.com/…, tiktok.com/t/…) by its redirect. */
export async function resolvePostId(url: string) {
  const id = postIdOf(url);
  if (id) return id;
  const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA.split(" Chrome/1")[0] } });
  return postIdOf(res.headers.get("Location") ?? "");
}

export interface Item {
  kind: Kind;
  mime: string;
  bytes: Uint8Array;
}
export interface Fetched {
  source: string;
  items: Item[];
}

const kindOfMime = (mime: string): Kind | null =>
  mime === "image/gif" ? "animation" : mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : null;
const kindOfName = (name = ""): Kind | null =>
  /\.gif$/i.test(name) ? "animation" : /\.(jpe?g|png|webp)$/i.test(name) ? "photo" : /\.(mp4|webm|mov)$/i.test(name) ? "video" : null;

/** Downloads one photo/video/GIF; `hint` is the kind when the server sends no media Content-Type. */
async function download(url: string, hint: Kind | null, headers: Record<string, string> = {}): Promise<Item> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  if (Number(res.headers.get("Content-Length")) > UPLOAD_MAX) throw new Error(`too large: ${url}`);
  const mime = res.headers.get("Content-Type")?.split(";")[0] ?? "";
  const kind = kindOfMime(mime) ?? hint;
  if (!kind) throw new Error(`not a photo or video: ${mime} ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > UPLOAD_MAX) throw new Error(`too large: ${url}`);
  return { kind, mime: kindOfMime(mime) ? mime : kind === "photo" ? "image/jpeg" : "video/mp4", bytes };
}

export async function fetchTiktok(postId: string): Promise<Fetched> {
  const page = await fetch(`https://www.tiktok.com/@i/video/${postId}`, { headers: { "User-Agent": UA } }); // also for photo posts
  const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const json = (await page.text()).split('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">')[1]?.split("</script>")[0];
  const detail = json && JSON.parse(json).__DEFAULT_SCOPE__?.["webapp.video-detail"];
  const item = !detail?.statusMsg && detail?.itemInfo?.itemStruct;
  if (!item?.author || item.isContentClassified) throw new Error(`TikTok post ${postId} unavailable`);

  const headers = { "User-Agent": UA, Cookie: cookie };
  const source = `https://www.tiktok.com/@${item.author.uniqueId}/video/${postId}`;
  const images: { imageURL: { urlList: string[] } }[] | undefined = item.imagePost?.images;
  if (images) {
    return { source, items: await Promise.all(images.map((i) => download(i.imageURL.urlList.find((u) => u.includes(".jpeg?"))!, "photo", headers))) };
  }
  if (!item.video?.playAddr) throw new Error(`TikTok post ${postId} has no video`);
  return { source, items: [await download(item.video.playAddr, "video", headers)] };
}

type CobaltReply = {
  status: string;
  url?: string;
  filename?: string;
  picker?: { type: "photo" | "video" | "gif"; url: string }[];
  error?: { code: string };
};

/** Media of `url` from the cobalt API (COBALT_URL, the public instance by default). */
export async function cobalt(env: Env, url: string, source = url): Promise<Fetched> {
  const auth: Record<string, string> = env.COBALT_API_KEY ? { Authorization: `Api-Key ${env.COBALT_API_KEY}` } : {};
  const res = await fetch(env.COBALT_URL ?? "https://api.cobalt.tools/", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...auth },
    // 720p keeps videos under the upload limit; GIFs stay mp4 so they fit in albums.
    body: JSON.stringify({ url, videoQuality: "720", convertGif: false }),
  });
  const r = await res.json<CobaltReply>();
  const kinds = { photo: "photo", video: "video", gif: "animation" } as const;
  if (r.picker) return { source, items: await Promise.all(r.picker.map((p) => download(p.url, kinds[p.type]))) };
  if (r.url) return { source, items: [await download(r.url, kindOfName(r.filename))] };
  throw new Error(`cobalt: ${r.error?.code ?? r.status}`);
}

/** Downloads media of a link, sends it to the user and saves it like forwarded media; an album becomes one post. */
export async function importLink(ctx: Ctx, env: Env, url: string) {
  const html = { parse_mode: "HTML" } as const;
  try {
    const postId = isTiktok(url) ? await resolvePostId(url) : null;
    const [where, key] = postId ? ["source LIKE ?", `https://www.tiktok.com/@%/video/${postId}`] : ["source = ?", url];
    const old = await env.DB.prepare(`SELECT 1 FROM memes WHERE user_id = ? AND status != 'failed' AND ${where}`).bind(ctx.user.id, key).first();
    if (old) return ctx.reply(t(ctx.lang, "already_saved"), html);
    await ctx.replyWithChatAction("upload_video").catch(() => {});
    const { source, items } = postId
      ? await fetchTiktok(postId).catch((e) => {
          console.error("tiktok direct download failed", url, e);
          return cobalt(env, url, `https://www.tiktok.com/@i/video/${postId}`);
        })
      : await cobalt(env, url);

    const reply_parameters = { message_id: ctx.msg!.message_id };
    const file = (it: Item, i: number) => new InputFile(it.bytes, `${i + 1}.${extOf(it.mime)}`);
    if (items.length === 1) {
      const [it] = items;
      const sent =
        it.kind === "photo"
          ? await ctx.replyWithPhoto(file(it, 0), { reply_parameters })
          : it.kind === "animation"
            ? await ctx.replyWithAnimation(file(it, 0), { reply_parameters })
            : await ctx.replyWithVideo(file(it, 0), { supports_streaming: true, reply_parameters });
      return receiveMedia(ctx, env, sent, { source });
    }
    // Albums have no GIFs: they go as videos. One group id for all chunks keeps the order in one post.
    const media = items.map((it, i) => (it.kind === "photo" ? InputMediaBuilder.photo(file(it, i)) : InputMediaBuilder.video(file(it, i))));
    const group = `link:${crypto.randomUUID()}`;
    for (let i = 0; i < media.length; i += ALBUM_MAX) {
      const sent = await ctx.replyWithMediaGroup(media.slice(i, i + ALBUM_MAX), { reply_parameters });
      for (const [j, msg] of sent.entries()) await receiveMedia(ctx, env, msg, { source, mediaGroupId: group, position: i + j });
    }
  } catch (e) {
    console.error("link import failed", url, e);
    return ctx.reply(t(ctx.lang, "link_failed"), html);
  }
}
