import { Buffer } from "node:buffer";
import { ImageResponse } from "workers-og";
import type { Meme } from "./db";
import type { Env } from "./env";
import { esc, langOf, t, type Key, type Lang } from "./i18n";
import { cachedMedia, extOf, memeMedia, toDataUrl } from "./media";
import { CSS } from "./uploadpage";
import { fileFits } from "./webapp";

const base = (env: Env) => env.PUBLIC_URL.replace(/\/$/, "");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
const mimeOf = (m: Meme) => m.mime ?? (m.kind === "photo" ? "image/jpeg" : "video/mp4");
const pageUrl = (env: Env, m: Meme) => `${base(env)}/s/${m.share_id}`;
const fileUrl = (env: Env, m: Meme) => (fileFits(m) ? `${base(env)}/d/${m.share_id}.${extOf(mimeOf(m))}` : null);
const titleOf = (m: Meme, lang: Lang) => m.title ?? t(lang, `share_${m.kind}`);

/** Public links of a meme; the first call makes the meme public (gives it a share id). */
export async function shareLinks(env: Env, meme: Meme) {
  const sid = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("base64url");
  meme.share_id = await env.DB.prepare("UPDATE memes SET share_id = COALESCE(share_id, ?) WHERE id = ? RETURNING share_id")
    .bind(sid, meme.id)
    .first<string>("share_id");
  return { page: pageUrl(env, meme), file: fileUrl(env, meme) };
}

/** GET /s/<sid> (page), /s/<sid>/og.png (preview image), /d/<sid>.<ext> (file) — public, no login. */
export async function handleShare(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const [, route, name = "", sub] = new URL(req.url).pathname.split("/");
  const sid = route === "d" ? name.split(".")[0] : name;
  // The meme is looked up before the edge cache, so a deleted meme is gone at once.
  const meme = sid ? await env.DB.prepare("SELECT * FROM memes WHERE share_id = ?").bind(sid).first<Meme>() : null;
  const kind = route === "d" && !sub ? "file" : route === "s" && !sub ? "page" : route === "s" && sub === "og.png" ? "og" : null;
  if (!meme || !kind || (kind === "file" && !fileFits(meme))) return new Response("Not found", { status: 404 });
  if (kind === "page") return page(env, meme, langOf({ language_code: req.headers.get("Accept-Language") ?? undefined }));
  return cachedMedia(req, ctx, async () => {
    if (kind === "og") return ogImage(env, meme);
    const media = await memeMedia(env, meme, "file").catch(() => null);
    return media && new Response(media.bytes, { headers: { "Content-Type": media.mime } });
  }, kind === "og" ? 86400 : 3600);
}

function page(env: Env, m: Meme, lang: Lang) {
  const s = (key: Key) => esc(t(lang, key));
  const title = attr(titleOf(m, lang));
  const file = fileUrl(env, m);
  const og = `${pageUrl(env, m)}/og.png`;
  const media = !file
    ? `<img src="${og}" alt="${title}">`
    : m.kind === "photo"
      ? `<img src="${file}" alt="${title}">`
      : `<video src="${file}" controls playsinline preload="metadata"${m.kind === "animation" ? " autoplay loop muted" : ""}></video>`;
  const sections: [Key, string | null][] = [
    ["share_text", m.ocr_text],
    ["share_speech", m.speech_text],
    ["share_description", m.description],
    ["share_context", m.meme_context],
    ["share_meaning", m.cultural_meaning],
    ["share_source", m.source],
    ["share_saved", m.saved_at ? new Date(m.saved_at * 1000).toLocaleString(lang) : null],
  ];
  const tags = m.tags ? m.tags.split("\n").filter(Boolean) : [];
  const video = file && m.kind !== "photo" ? `<meta property="og:video" content="${file}"><meta property="og:video:type" content="${attr(mimeOf(m))}">` : "";
  const html = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title}</title>
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="memereserve">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${attr((m.description ?? m.caption ?? "").slice(0, 200))}">
  <meta property="og:url" content="${pageUrl(env, m)}">
  <meta property="og:image" content="${og}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  ${video}
  <link rel="stylesheet" href="${CSS}">
  <style>.stage{display:grid;place-items:center;background:#09090b;border-radius:var(--cf-radius-lg);overflow:hidden}.stage img,.stage video{max-inline-size:100%;max-block-size:80vh;object-fit:contain}.pre{white-space:pre-wrap}</style>
</head>
<body>
  <main class="cf-container cf-container--narrow cf-section">
    <div class="cf-stack">
      <h1 class="cf-heading cf-heading--2">${title}</h1>
      <div class="stage">${media}</div>
      ${tags.length ? `<div class="cf-inline">${tags.map((tag) => `<span class="cf-tag">#${esc(tag)}</span>`).join(" ")}</div>` : ""}
      ${sections
        .filter(([, value]) => value)
        .map(([key, value]) => `<div class="cf-stack" data-gap="sm"><h2 class="cf-heading cf-heading--4">${s(key)}</h2><p class="cf-text pre">${esc(value!)}</p></div>`)
        .join("\n      ")}
      ${file ? `<div><a class="cf-button" href="${file}" download>${s("share_download")}</a></div>` : ""}
      <p class="cf-text cf-text--muted cf-text--sm"><a href="${base(env)}/bot">${s("share_footer")}</a></p>
    </div>
  </main>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const FONT = "https://cdn.jsdelivr.net/npm/@fontsource/manrope@5.2.8/files/manrope";
type Font = { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" };
let fonts: Promise<Font[]> | undefined;
/** Manrope (the design system font) as woff: satori cannot read woff2. Loaded once per isolate. */
const loadFonts = () =>
  (fonts ??= Promise.all(
    (["latin", "cyrillic"] as const).flatMap((subset) =>
      ([400, 700] as const).map(async (weight): Promise<Font> => {
        const res = await fetch(`${FONT}-${subset}-${weight}-normal.woff`, { cf: { cacheEverything: true, cacheTtl: 30 * 86400 } });
        if (!res.ok) throw new Error(`font ${res.status}`);
        return { name: `Manrope-${subset}`, data: await res.arrayBuffer(), weight, style: "normal" };
      }),
    ),
  ).catch((e) => {
    fonts = undefined;
    throw e;
  }));

type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, props: Record<string, unknown> = {}): Node => ({
  type,
  props: { style, children, ...props },
});

/** 1200×630 preview card in the memereserve design (dark design-system tokens). */
async function ogImage(env: Env, m: Meme) {
  const preview = await memeMedia(env, m, "preview").catch(() => null);
  const src = preview && /^image\/(jpeg|png)$/.test(preview.mime) ? toDataUrl(preview) : null; // satori reads only jpeg and png
  const tags = (m.tags ?? "").split("\n").filter(Boolean).slice(0, 4);
  const title = titleOf(m, "en");
  const card = h("div", { display: "flex", width: 1200, height: 630, padding: 48, gap: 48, background: "#18181b", color: "#e4e4e7", fontFamily: "Manrope-latin, Manrope-cyrillic" }, [
    h(
      "div",
      { display: "flex", width: 534, height: 534, borderRadius: 24, background: "#09090b", border: "1px solid #3f3f46", alignItems: "center", justifyContent: "center", overflow: "hidden" },
      src ? h("img", { width: 534, height: 534, objectFit: "contain" }, undefined, { src, width: 534, height: 534 }) : h("div", { fontSize: 40, color: "#a1a1aa" }, t("en", `share_${m.kind}`)),
    ),
    h("div", { display: "flex", flexDirection: "column", flex: 1, justifyContent: "space-between" }, [
      h("div", { display: "flex", flexDirection: "column", gap: 24 }, [
        h("div", { display: "block", fontSize: 56, fontWeight: 700, lineHeight: 1.15, lineClamp: 4 }, title.length > 120 ? `${title.slice(0, 119)}…` : title),
        h(
          "div",
          { display: "flex", flexWrap: "wrap", gap: 12 },
          tags.map((tag) => h("div", { display: "flex", padding: "8px 18px", borderRadius: 999, background: "#082f49", color: "#38bdf8", fontSize: 26 }, `#${tag}`)),
        ),
      ]),
      h("div", { display: "flex", flexDirection: "column", gap: 4 }, [
        h("div", { fontSize: 40, fontWeight: 700, color: "#38bdf8" }, "memereserve"),
        h("div", { fontSize: 26, color: "#a1a1aa" }, new URL(env.PUBLIC_URL).host),
      ]),
    ]),
  ]);
  return new ImageResponse(card as never, { width: 1200, height: 630, fonts: await loadFonts() });
}
