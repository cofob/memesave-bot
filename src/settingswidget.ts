// /settings as a widget: segmented switches that answer at once; the bot saves the choice and confirms the state.
import type { Api } from "grammy";
import type { User } from "./db";
import type { Env } from "./env";
import { t, type Lang } from "./i18n";
import { editWidget, page, sendWidget, widgetLabels, type WidgetQuery } from "./widget";

/** State: {m: search mode, t: describe tier, p: 1 when porn is hidden, b: 1 when porn is blurred}. A tap asks c<group>:<value> (cm:fast, ct:max, cp:1). */
export const settingsPage = (lang: Lang) =>
  page(
    ".grp{display:flex;flex-direction:column;gap:6px}.seg button{flex:1}.pend{color:var(--cf-color-text-subtle)}",
    "<div id=r style='display:flex;flex-direction:column;gap:var(--cf-space-3)'></div>",
    `let o={};const G=[['m',L.set_search,[['advanced',L.adv,L.h_adv],['fast',L.fast,L.h_fast]]],['t',L.set_tier,[['max',L.max,L.h_max],['medium',L.medium,L.h_medium]]],['p',L.set_porn,[[0,L.shown,L.h_shown],[1,L.hidden,L.h_hidden]]],['b',L.set_blur,[[1,L.on,L.h_blur_on],[0,L.off,L.h_blur_off]]]];
function draw(){const s=S()||{},v=k=>k in o?o[k]:s[k];R($('r'),...G.map(([k,title,opts])=>{const g=E('grp'),seg=E('seg'),cur=opts.find(x=>x[0]==v(k))||opts[0];
R(seg,...opts.map(([val,l])=>{const b=E(val==cur[0]?'on':'',l,'button');b.onclick=()=>{if(val==v(k))return;o[k]=val;draw();
W.request('c'+k+':'+val).catch(()=>{}).then(()=>{delete o[k];draw()})};return b}));
R(g,E('title',title),seg,E(k in o?'muted pend':'muted',cur[2]));return g}))}
draw();W.onEvent('chatDataChanged',draw);`,
    widgetLabels(lang, [
      "w_set_search", "w_set_tier", "w_set_porn", "w_adv", "w_fast", "w_max", "w_medium",
      "w_shown", "w_hidden", "w_h_adv", "w_h_fast", "w_h_max", "w_h_medium", "w_h_shown", "w_h_hidden",
      "w_set_blur", "w_on", "w_off", "w_h_blur_on", "w_h_blur_off",
    ]),
  );

const state = (u: Pick<User, "search_mode" | "describe_tier" | "hide_porn" | "blur_porn">) =>
  JSON.stringify({ m: u.search_mode, t: u.describe_tier, p: u.hide_porn ? 1 : 0, b: u.blur_porn ? 1 : 0 });

/** Sends the settings widget; false when Telegram refuses it (the caller sends the keyboard). */
export const sendSettingsWidget = async (api: Api, user: User, lang: Lang) =>
  !!(await sendWidget(api, { chat_id: user.id, html: settingsPage(lang), caption: t(lang, "w_settings_caption"), parse_mode: "HTML", chat_data: state(user), allow_queries: true }));

const SET: Record<string, [column: string, values: string[]]> = {
  m: ["search_mode", ["advanced", "fast"]],
  t: ["describe_tier", ["max", "medium"]],
  p: ["hide_porn", ["0", "1"]],
  b: ["blur_porn", ["0", "1"]],
};

/** A switch tap: saves the setting and gives the widget the new state. */
export async function settingsQuery(env: Env, api: Api, q: WidgetQuery, user: User) {
  const [, key, value] = q.data.match(/^c([mtpb]):(\w+)$/) ?? [];
  if (!key || !SET[key][1].includes(value) || q.chat?.id !== user.id || !q.message_id) return;
  const u = await env.DB.prepare(`UPDATE users SET ${SET[key][0]} = ? WHERE id = ? RETURNING *`)
    .bind(key === "p" || key === "b" ? Number(value) : value, user.id)
    .first<User>();
  if (u) await editWidget(api, user.id, q.message_id, state(u));
}
