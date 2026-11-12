// The status of a saved meme as a widget: indexing, then the title and tags; an album shows its progress.
import type { Api } from "grammy";
import { botApi } from "./botapi";
import type { Env } from "./env";
import { t, type Lang } from "./i18n";
import { editWidget, page, progressApi, sendWidget, widgetLabels } from "./widget";

/**
 * State: {s: "i" indexing | "r" ready | "f" failed | "m" a message, t: title, g: tags, e: error, x: message text}
 * or, for an album, {n: memes, d: finished, r: ready titles, s}.
 */
export const savePage = (lang: Lang) =>
  page(
    ".err{color:var(--cf-color-danger)}.list{display:flex;flex-direction:column;gap:2px}",
    "<div id=r style='display:flex;flex-direction:column;gap:var(--cf-space-2)'></div>",
    `function bar(v){const tr=E(v==null?'track ind':'track'),f=E('fill');if(v!=null)f.style.width=v+'%';tr.appendChild(f);return tr}
function draw(){const s=S()||{s:'i'},o=[];
if(s.n){const h=E('row sp');R(h,E('title',L.album),E('muted',s.d+' / '+s.n,'span'));o.push(h,bar(100*s.d/s.n));
if(s.r&&s.r.length){const l=E('list');s.r.forEach(x=>l.appendChild(E('ell','• '+x)));o.push(l)}}
else if(s.s==='r'){o.push(E('muted',L.saved_one),E('title',s.t));if(s.g&&s.g.length){const c=E('chips');R(c,...s.g.map(x=>E('chip','#'+x,'span')));o.push(c)}}
else if(s.s==='f')o.push(E('title err',L.failed),E('muted',s.e));
else if(s.s==='m')o.push(E('',s.x));
else o.push(E('muted',L.indexing),bar());
R($('r'),...o)}
draw();W.onEvent('chatDataChanged',draw);`,
    widgetLabels(lang, ["w_indexing", "w_saved_one", "w_failed", "w_album"]),
  );

/** Keeps the state under 1024 bytes: drops the last tags and titles. */
function fit(state: { g?: string[]; r?: string[] }) {
  let json = JSON.stringify(state);
  while (new TextEncoder().encode(json).length > 1000 && (state.g?.length || state.r?.length)) {
    (state.r?.length ? state.r : state.g)!.pop();
    json = JSON.stringify(state);
  }
  return json;
}

/** The "indexing" status as a reply to the meme; a text message when Telegram refuses the widget. Returns its id. */
export async function sendSaveStatus(api: Api, chatId: number, lang: Lang, replyTo: number) {
  const reply_parameters = { message_id: replyTo };
  const caption = t(lang, "saving");
  const sent = await sendWidget(api, { chat_id: chatId, html: savePage(lang), caption, parse_mode: "HTML", chat_data: fit({ s: "i" } as never), reply_parameters });
  return sent?.message_id ?? (await api.sendMessage(chatId, caption, { parse_mode: "HTML", reply_parameters })).message_id;
}

/**
 * Shows a new status: the widget's state, and its caption once final (the text clients without widgets see).
 * A status message sent as text (Telegram refused the widget, or sent before widgets) gets the text instead.
 */
export async function showSaveStatus(env: Env, chatId: number, msgId: number, text: string, state: object, final: boolean, caption = text) {
  const api = botApi(env.BOT_TOKEN);
  const html = { parse_mode: "HTML" } as const;
  // An album's in-between progress does not wait on a 429 (see progressApi): the next meme or the final state catches up.
  const widget = await editWidget(final ? api : progressApi(env.BOT_TOKEN), chatId, msgId, fit(state)).then(
    () => true,
    () => false,
  );
  if (!widget) return api.editMessageText(chatId, msgId, text, html).catch(console.error);
  if (final) await api.editMessageCaption(chatId, msgId, { caption, ...html }).catch(console.error);
}
