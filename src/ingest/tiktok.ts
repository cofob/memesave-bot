import { InputFile, InputMediaBuilder } from "grammy";
import type { Ctx } from "../bot";
import type { Env } from "../env";
import { t } from "../i18n";
import { receiveMedia } from "./receive";

// TikTok download the way cobalt (github.com/imputnet/cobalt) does it: the post page embeds its data as JSON,
// and the media CDN wants the page cookies.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const ALBUM_MAX = 10; // Telegram media group limit

export const tiktokLink = (text: string) => text.match(/https?:\/\/(?:[\w-]+\.)?tiktok\.com\/\S+/i)?.[0] ?? null;

const postIdOf = (url: string) => url.match(/\/(?:video|photo)\/(\d{1,21})|\/v\/(\d{1,21})\.html/)?.slice(1).find(Boolean) ?? null;

/** Post id of a full link, or of a short link (vm.tiktok.com/…, tiktok.com/t/…) by its redirect. */
export async function resolvePostId(url: string) {
  const id = postIdOf(url);
  if (id) return id;
  const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA.split(" Chrome/1")[0] } });
  return postIdOf(res.headers.get("Location") ?? "");
}

export interface Tiktok {
  source: string;
  video?: Uint8Array;
  photos?: Uint8Array[];
}

async function download(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TikTok download ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchTiktok(postId: string): Promise<Tiktok> {
  const page = await fetch(`https://www.tiktok.com/@i/video/${postId}`, { headers: { "User-Agent": UA } }); // also for photo posts
  const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const json = (await page.text()).split('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">')[1]?.split("</script>")[0];
  const detail = json && JSON.parse(json).__DEFAULT_SCOPE__?.["webapp.video-detail"];
  const item = !detail?.statusMsg && detail?.itemInfo?.itemStruct;
  if (!item?.author || item.isContentClassified) throw new Error(`TikTok post ${postId} unavailable`);

  const get = (url: string) => download(url, { "User-Agent": UA, Cookie: cookie });
  const source = `https://www.tiktok.com/@${item.author.uniqueId}/video/${postId}`;
  const images: { imageURL: { urlList: string[] } }[] | undefined = item.imagePost?.images;
  if (images) return { source, photos: await Promise.all(images.map((i) => get(i.imageURL.urlList.find((u) => u.includes(".jpeg?"))!))) };
  if (!item.video?.playAddr) throw new Error(`TikTok post ${postId} has no video`);
  return { source, video: await get(item.video.playAddr) };
}

/** The same through a cobalt API instance (COBALT_URL, the public one by default). */
export async function cobaltTiktok(env: Env, url: string, postId: string): Promise<Tiktok> {
  const auth: Record<string, string> = env.COBALT_API_KEY ? { Authorization: `Api-Key ${env.COBALT_API_KEY}` } : {};
  const res = await fetch(env.COBALT_URL ?? "https://api.cobalt.tools/", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ url }),
  });
  const r = await res.json<{ status: string; url?: string; picker?: { type: string; url: string }[]; error?: { code: string } }>();
  const source = `https://www.tiktok.com/@i/video/${postId}`;
  if (r.picker) return { source, photos: await Promise.all(r.picker.filter((p) => p.type === "photo").map((p) => download(p.url))) };
  if (r.url) return { source, video: await download(r.url) };
  throw new Error(`cobalt: ${r.error?.code ?? r.status}`);
}

/** Downloads a TikTok post, sends it to the user and saves it like forwarded media; a slideshow becomes one post. */
export async function importTiktok(ctx: Ctx, env: Env, url: string) {
  const html = { parse_mode: "HTML" } as const;
  try {
    const postId = await resolvePostId(url);
    if (!postId) throw new Error(`No TikTok post id in ${url}`);
    const old = await env.DB.prepare("SELECT 1 FROM memes WHERE user_id = ? AND source LIKE ?").bind(ctx.user.id, `%/video/${postId}`).first();
    if (old) return ctx.reply(t(ctx.lang, "already_saved"), html);
    await ctx.replyWithChatAction("upload_video").catch(() => {});
    const tt = await fetchTiktok(postId).catch((e) => {
      console.error("tiktok direct download failed", url, e);
      return cobaltTiktok(env, url, postId);
    });
    const reply_parameters = { message_id: ctx.msg!.message_id };
    if (tt.video) {
      const sent = await ctx.replyWithVideo(new InputFile(tt.video, `${postId}.mp4`), { supports_streaming: true, reply_parameters });
      return receiveMedia(ctx, env, sent, { source: tt.source });
    }
    const photos = tt.photos!.map((p, i) => InputMediaBuilder.photo(new InputFile(p, `${postId}_${i + 1}.jpg`)));
    for (let i = 0; i < photos.length; i += ALBUM_MAX) {
      const sent = await ctx.replyWithMediaGroup(photos.slice(i, i + ALBUM_MAX), { reply_parameters });
      for (const [j, msg] of sent.entries()) {
        await receiveMedia(ctx, env, msg, { source: tt.source, mediaGroupId: `tt:${postId}`, position: i + j });
      }
    }
  } catch (e) {
    console.error("tiktok import failed", url, e);
    return ctx.reply(t(ctx.lang, "link_failed"), html);
  }
}
