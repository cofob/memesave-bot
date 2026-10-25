import { esc, t, type Lang } from "./i18n";

const CSS = "https://cdn.jsdelivr.net/npm/@cofob2/design-system-css@0.5.0/dist/index.css";
const PART_SIZE = 50 * 1024 * 1024; // under the 100 MB Worker request limit; R2 needs >= 5 MB parts

const SCRIPT = `
const q = location.search, base = location.pathname, PART = ${PART_SIZE};
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, init) {
  const r = await fetch(base + path + q + (init?.query ?? ""), init);
  if (!r.ok) throw new Error((await r.text()) || r.status);
  return r.json();
}
async function upload(file) {
  $("upload").hidden = true;
  $("progress").hidden = false;
  $("name").textContent = file.name;
  await call("/start", { method: "POST" });
  const count = Math.ceil(file.size / PART), parts = [];
  let next = 0, sent = 0;
  async function worker() {
    while (next < count) {
      const i = next++, blob = file.slice(i * PART, (i + 1) * PART);
      for (let attempt = 0; ; attempt++) {
        try {
          parts[i] = await call("/part", { method: "PUT", body: blob, query: "&n=" + (i + 1) });
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          await sleep(2000 * (attempt + 1));
        }
      }
      sent += blob.size;
      const pct = Math.floor((sent / file.size) * 100);
      $("bar").value = pct;
      $("value").textContent = pct + "%";
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  await call("/complete", { method: "POST", body: JSON.stringify({ parts }), headers: { "Content-Type": "application/json" } });
  $("progress").hidden = true;
  $("ok").hidden = false;
}
function start(file) {
  if (!file) return;
  upload(file).catch((e) => {
    $("progress").hidden = true;
    $("err").hidden = false;
    $("errmsg").textContent = String(e.message || e);
  });
}
$("file").addEventListener("change", (e) => start(e.target.files[0]));
const zone = $("zone");
zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.dataset.dragging = "true"; });
zone.addEventListener("dragleave", () => delete zone.dataset.dragging);
zone.addEventListener("drop", (e) => { e.preventDefault(); delete zone.dataset.dragging; start(e.dataTransfer.files[0]); });
`;

/** Upload page for a Telegram export zip, styled with the cofob design system. */
export function uploadPage(lang: Lang, open: boolean) {
  const s = (key: Parameters<typeof t>[1]) => esc(t(lang, key));
  const body = open
    ? `<label class="cf-file-upload" id="upload">
        <input class="cf-file-upload__input" type="file" accept=".zip,application/zip" id="file">
        <span class="cf-file-upload__dropzone" id="zone">
          <span class="cf-file-upload__prompt">${s("page_drop")}</span>
          <span class="cf-file-upload__hint">${s("page_hint")}</span>
        </span>
      </label>
      <div class="cf-progress" id="progress" hidden>
        <div class="cf-progress__header"><span class="cf-progress__label" id="name"></span><span class="cf-progress__value" id="value">0%</span></div>
        <progress class="cf-progress__track" id="bar" max="100" value="0"></progress>
      </div>
      <div class="cf-alert" data-tone="success" id="ok" hidden><div class="cf-alert__content"><p class="cf-alert__title">${s("page_done")}</p></div></div>
      <div class="cf-alert" data-tone="danger" id="err" hidden><div class="cf-alert__content"><p class="cf-alert__title">${s("page_error")}</p><p class="cf-alert__description" id="errmsg"></p></div></div>`
    : `<div class="cf-alert" data-tone="warning"><div class="cf-alert__content"><p class="cf-alert__title">${s("page_used")}</p></div></div>`;
  const html = `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${s("page_title")}</title>
  <link rel="stylesheet" href="${CSS}">
</head>
<body>
  <main class="cf-container cf-container--narrow cf-section">
    <div class="cf-stack">
      <h1 class="cf-heading cf-heading--2">${s("page_title")}</h1>
      <p class="cf-text cf-text--muted">${s("page_lead")}</p>
      <div class="cf-card"><div class="cf-card__body cf-stack">${body}</div></div>
    </div>
  </main>
  ${open ? `<script>${SCRIPT}</script>` : ""}
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
