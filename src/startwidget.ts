// /start as a widget: a short carousel of what the bot does (swipe or tap), with the usual buttons under it.
import type { Api } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { t, type Lang } from "./i18n";
import { page, sendWidget, widgetLabels } from "./widget";

const ICONS = ["📥", "🔍", "💬", "📱"];

export const startPage = (lang: Lang, bot: string) => {
  const l = widgetLabels(lang, ["w_s1_t", "w_s1_d", "w_s2_t", "w_s2_d", "w_s3_t", "w_s3_d", "w_s4_t", "w_s4_d", "w_next", "w_back"]);
  l.s3_d = l.s3_d.replace("{bot}", bot);
  return page(
    ".vp{overflow:hidden;touch-action:pan-y;width:100%;min-width:0}.sl{display:flex;transition:transform .3s ease}.s{flex:0 0 100%;min-width:0;display:flex;flex-direction:column;gap:var(--cf-space-1);min-height:8.5rem}.ico{width:2.75rem;height:2.75rem;border-radius:9999px;background:var(--cf-color-surface);display:flex;align-items:center;justify-content:center;font-size:1.375rem;margin-bottom:var(--cf-space-1)}.dots{display:flex;gap:6px}.dot{width:6px;height:6px;border-radius:9999px;background:var(--cf-color-text-subtle)}.dot.on{width:18px;background:var(--cf-color-accent)}.nav{display:flex;gap:var(--cf-space-2)}.nav button{width:auto;min-height:2rem}.sec{border:0;border-radius:var(--cf-radius-md);background:var(--cf-color-surface);color:var(--cf-color-text);font:inherit;font-weight:600;padding:var(--cf-space-1) var(--cf-space-3)}",
    "<div class=vp id=vp><div class=sl id=sl></div></div><div class='row sp'><div class=dots id=d></div><div class=nav><button class=sec id=b></button><button class=primary id=n></button></div></div>",
    `const I=${JSON.stringify(ICONS)},N=I.length;let i=0;
R($('sl'),...I.map((ic,j)=>{const s=E('s');R(s,E('ico',ic),E('title',L['s'+(j+1)+'_t']),E('muted',L['s'+(j+1)+'_d']));return s}));
const b=$('b'),n=$('n');b.textContent=L.back;n.textContent=L.next;
function go(j){i=Math.max(0,Math.min(N-1,j));$('sl').style.transform='translateX('+(-100*i)+'%)';R($('d'),...I.map((_,k)=>E(k==i?'dot on':'dot')));b.style.visibility=i?'visible':'hidden';n.style.visibility=i<N-1?'visible':'hidden'}
b.onclick=()=>go(i-1);n.onclick=()=>go(i+1);
let x0=null;const vp=$('vp');vp.addEventListener('pointerdown',e=>{x0=e.clientX});vp.addEventListener('pointercancel',()=>{x0=null});
vp.addEventListener('pointerup',e=>{if(x0==null)return;const dx=e.clientX-x0;x0=null;if(Math.abs(dx)>40)go(i+(dx<0?1:-1))});
go(0);`,
    l,
  );
};

/** Sends the welcome carousel; false when Telegram refuses it (the caller sends the text). */
export const sendStartWidget = async (api: Api, chatId: number, lang: Lang, bot: string, keyboard: InlineKeyboardButton[][]) =>
  !!(await sendWidget(api, { chat_id: chatId, html: startPage(lang, bot), caption: t(lang, "w_start_caption"), reply_markup: { inline_keyboard: keyboard } }));
