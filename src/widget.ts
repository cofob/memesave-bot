// HTML widgets (Bot API 10.4): fixed HTML plus state that only the bot writes. https://core.telegram.org/bots/widgets
import { Api } from "grammy";
import type { User } from "grammy/types";
import { t, type Key, type Lang } from "./i18n";

// grammy 1.46 has no typings for these methods; api.raw still calls them (with the retry transformer).
type Raw = Record<string, (p: object) => Promise<any>>;
const raw = (api: Api) => api.raw as unknown as Raw;

export interface WidgetQuery {
  id: string;
  from: User;
  chat?: { id: number };
  message_id?: number;
  data: string;
}

export interface WidgetMessage {
  message_id: number;
  widget?: { id?: string };
}

export interface WidgetParams {
  chat_id: number;
  html: string;
  /** Shown in the chat list and by clients without widgets. */
  caption: string;
  parse_mode?: "HTML";
  chat_data?: string;
  public_data?: string;
  allow_queries?: boolean;
  is_shared?: boolean;
  height?: number;
  reply_markup?: unknown;
  reply_parameters?: unknown;
}

const orNull = (method: string) => (e: unknown) => (console.error(method, e), null);

/** The sent message, or null when Telegram refuses the widget (the caller falls back to text). */
export const sendWidget = (api: Api, p: WidgetParams): Promise<WidgetMessage | null> => raw(api).sendWidget(p).catch(orNull("sendWidget"));

export const sendSharedWidget = (api: Api, chat_id: number, widget_id: string, extra: object = {}): Promise<WidgetMessage | null> =>
  raw(api).sendSharedWidget({ chat_id, widget_id, ...extra }).catch(orNull("sendSharedWidget"));

// The same state again is "message is not modified": the widget already shows it.
const notModified = (e: unknown) => {
  if (!String(e).includes("not modified")) throw e;
};

/** A silent edit of the message's state: no "edited" mark, no notification. */
export const editWidget = (api: Api, chat_id: number, message_id: number, chat_data: string): Promise<unknown> =>
  raw(api).editMessageWidgetData({ chat_id, message_id, chat_data }).catch(notModified);

/**
 * An Api for in-between progress edits: no retry on a 429. A retry waits up to a minute, so a late edit could land after
 * newer ones and move the progress back (and the caller's request could time out and come again); the next update
 * catches up. Final states use the retrying botApi.
 */
export const progressApi = (token: string) => new Api(token);

/** At most once per second per shared widget. */
export const editSharedWidget = (api: Api, widget_id: string, public_data: string): Promise<unknown> =>
  raw(api).editSharedWidgetData({ widget_id, public_data }).catch(notModified);

export const answerWidget = (api: Api, widget_query_id: string, data?: string): Promise<unknown> => raw(api).answerWidgetQuery({ widget_query_id, data });

// The Mini App's design tokens (@cofob2/design-system-css) on the chat's theme, as syncTheme() in app/src/telegram.ts maps them.
// Widgets have no color-mix(), logical properties or web fonts: the chat's font and theme colors only.
const CSS = `:root{--cf-color-canvas:var(--tg-theme-bg-color);--cf-color-surface:var(--tg-theme-secondary-bg-color);--cf-color-surface-raised:var(--tg-theme-section-bg-color);--cf-color-text:var(--tg-theme-text-color);--cf-color-text-muted:var(--tg-theme-subtitle-text-color);--cf-color-text-subtle:var(--tg-theme-hint-color);--cf-color-border:var(--tg-theme-section-separator-color);--cf-color-accent:var(--tg-theme-button-color);--cf-color-accent-contrast:var(--tg-theme-button-text-color);--cf-color-danger:var(--tg-theme-destructive-text-color);--cf-space-1:.25rem;--cf-space-2:.5rem;--cf-space-3:.75rem;--cf-radius-md:.5rem;--cf-radius-lg:.75rem}
html{overflow:hidden}
body{margin:0;overflow:hidden;padding:var(--cf-space-3);padding-bottom:max(var(--cf-space-3),env(safe-area-inset-bottom));color:var(--cf-color-text);display:flex;flex-direction:column;gap:var(--cf-space-3);font-variant-numeric:tabular-nums}
.row{display:flex;align-items:center;gap:var(--cf-space-2)}
.sp{justify-content:space-between}
.col{display:flex;flex-direction:column;min-width:0}
.title{font-weight:600}
.big{font-size:1.75rem;font-weight:700;line-height:1.1}
.accent{color:var(--cf-color-accent)}
.muted{color:var(--cf-color-text-muted);font-size:.8125rem}
.ell{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpis{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px;border-radius:var(--cf-radius-lg);overflow:hidden}
.kpi{background:var(--cf-color-surface);padding:var(--cf-space-2);display:flex;flex-direction:column;min-width:0}
.kpi b{font-size:1.0625rem;line-height:1.3}.kpi span{font-size:.75rem;line-height:1.25}
.track{height:6px;border-radius:9999px;background:var(--cf-color-surface);overflow:hidden}
.fill{height:100%;width:0;background:var(--cf-color-accent);border-radius:inherit;transition:width .3s}
.seg{display:flex;background:var(--cf-color-surface);border-radius:var(--cf-radius-md);padding:2px}
.seg button{border:0;background:none;color:var(--cf-color-text-muted);font:inherit;font-size:.8125rem;font-weight:600;padding:var(--cf-space-1) var(--cf-space-3);border-radius:6px}
.seg button.on{background:var(--cf-color-canvas);color:var(--cf-color-text);box-shadow:0 1px 2px rgba(0,0,0,.15)}
.icon{border:0;background:var(--cf-color-surface);color:var(--cf-color-text);width:2rem;height:2rem;border-radius:9999px;font:inherit;font-size:1.0625rem;line-height:1;padding:0}
.icon[disabled]{color:var(--cf-color-text-subtle)}
.chips{display:flex;flex-wrap:wrap;gap:var(--cf-space-1)}
.chip{background:var(--cf-color-surface);border-radius:9999px;padding:2px 10px;font-size:.8125rem}
.primary{border:0;border-radius:var(--cf-radius-md);background:var(--cf-color-accent);color:var(--cf-color-accent-contrast);font:inherit;font-weight:600;padding:var(--cf-space-2) var(--cf-space-3);min-height:2.5rem;width:100%}
.ind{position:relative}.ind .fill{position:absolute;width:35%;animation:ind 1.4s ease-in-out infinite}
@keyframes ind{from{left:-35%}to{left:100%}}
@media (prefers-reduced-motion:reduce){.ind .fill{animation:none;left:0;width:100%;background:var(--cf-color-text-subtle)}}`;

// W: the bridge; $: by id (ids are not globals in widgets); S/P: the chat and shared state as JSON, null when absent;
// E: an element with a class and text; R: replaces an element's children; T: a stat (value over label); K: a strip of stats.
const JS = `const W=TelegramWidget,$=i=>document.getElementById(i),J=s=>{try{return JSON.parse(s)}catch(e){return null}},S=()=>J(W.chatData),P=()=>J(W.publicData),
E=(c,t,n='div')=>{const e=document.createElement(n);e.className=c;if(t!=null)e.textContent=t;return e},R=(e,...c)=>{e.innerHTML='';c.forEach(x=>e.appendChild(x))},
T=(l,v)=>{const e=E('kpi');R(e,E('ell',v??'–','b'),E('muted',l,'span'));return e},K=(...t)=>{const e=E('kpis');R(e,...t);return e};`;

/** Widget labels by i18n key without the "w_" prefix. */
export const widgetLabels = (lang: Lang, keys: Key[]) => Object.fromEntries(keys.map((k) => [k.slice(2), t(lang, k)]));

/** A widget page: shared styles, markup, and a script with the labels as L (in the user's language, fixed at send time). */
export const page = (css: string, body: string, script: string, labels: object) =>
  `<style>${CSS}${css}</style>${body}<script>${JS}const L=${JSON.stringify(labels).replace(/</g, "\\u003c")};${script}</script>`;
