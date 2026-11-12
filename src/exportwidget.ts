// /export as a widget: the stage while the archive is built, then its size and a download button.
import type { Api } from "grammy";
import { botApi } from "./botapi";
import type { Env } from "./env";
import { t, type Lang } from "./i18n";
import { editWidget, page, sendWidget, widgetLabels } from "./widget";

/** State: {s: 0 collecting | 1 packing | 2 ready | 3 failed, z: size MB, f: files, x: unreadable, u: download URL}. */
export const exportPage = (lang: Lang) =>
  page(
    ".err{color:var(--cf-color-danger)}",
    "<div id=r style='display:flex;flex-direction:column;gap:var(--cf-space-2)'></div>",
    `function draw(){const s=S()||{s:0},o=[E('title',L.export)];
if(s.s<2){const tr=E('track ind');tr.appendChild(E('fill'));o.push(E('muted',s.s?L.ex_upload:L.ex_collect),tr)}
else if(s.s==3)o.push(E('err',L.ex_failed));
else{o.push(K(T(L.ex_size+', MB',s.z),T(L.ex_files,s.f),T(L.ex_unread,s.x)));const b=E('primary',L.ex_download,'button');b.onclick=()=>W.openLink(s.u);o.push(b,E('muted',L.ex_expired))}
R($('r'),...o)}
draw();W.onEvent('chatDataChanged',draw);`,
    widgetLabels(lang, ["w_export", "w_ex_collect", "w_ex_upload", "w_ex_failed", "w_ex_size", "w_ex_files", "w_ex_unread", "w_ex_download", "w_ex_expired"]),
  );

/** The export status message: the widget, or the old text when Telegram refuses it. Returns its id. */
export async function sendExportStatus(api: Api, chatId: number, lang: Lang) {
  const caption = t(lang, "export_started");
  const sent = await sendWidget(api, { chat_id: chatId, html: exportPage(lang), caption, parse_mode: "HTML", chat_data: JSON.stringify({ s: 0 }) });
  return sent?.message_id ?? (await api.sendMessage(chatId, caption, { parse_mode: "HTML" })).message_id;
}

/** A new export state; a text status message (refused widget) ignores it, the text messages tell the outcome. */
export const showExport = (env: Env, ex: { user_id: number; status_msg_id: number | null }, state: object) =>
  ex.status_msg_id ? editWidget(botApi(env.BOT_TOKEN), ex.user_id, ex.status_msg_id, JSON.stringify(state)).catch(() => {}) : undefined;
