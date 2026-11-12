// The collection analysis as a widget: its stages with the progress of the current one; the report follows as messages.
import type { Api } from "grammy";
import { botApi } from "./botapi";
import type { Env } from "./env";
import { t, type Lang } from "./i18n";
import { editWidget, page, sendWidget, widgetLabels } from "./widget";

const STAGES = ["vectors", "project", "cluster", "extras"]; // analyze/main.go and analyze/analyze.go

/** State: {s: stage, p: its progress %, l: 1 with AI names (one more step), d: 1 done, e: 1 failed}. */
export const analysisPage = (lang: Lang) =>
  page(
    ".steps{display:flex;flex-direction:column;gap:6px}.ic{width:1.25rem;text-align:center;color:var(--cf-color-text-subtle)}.ok .ic{color:var(--cf-color-accent)}.now{font-weight:600}.wait{color:var(--cf-color-text-subtle)}.err{color:var(--cf-color-danger)}",
    "<div id=r style='display:flex;flex-direction:column;gap:var(--cf-space-2)'></div>",
    `const ST=${JSON.stringify(STAGES)};
function draw(){const s=S()||{},n=ST.length+(s.l?1:0),x=ST.indexOf(s.s),i=s.d?n:x>=0?x:s.s?n-1:0,cur=s.s==='extras'&&s.p>=100&&s.l?ST.length:i,all=Math.min(100,100*(cur+(s.d?0:(s.p||0)/100))/n);
const h=E('row sp');R(h,E('title',L.an_title,'span'),E('muted',Math.round(all)+'%','span'));
const tr=E('track'),f=E('fill');f.style.width=all+'%';tr.appendChild(f);
const st=E('steps');[...ST,...(s.l?['write']:[])].forEach((k,j)=>{const r=E(j<cur||s.d?'row ok':j==cur?'row now':'row wait');
R(r,E('ic',j<cur||s.d?'✓':j==cur?'●':'○','span'),E('ell',L['an_'+k],'span'));if(j==cur&&!s.d&&s.p)r.appendChild(E('muted',s.p+'%','span'));st.appendChild(r)});
R($('r'),h,tr,st,...(s.d?[E('muted',L.an_done)]:s.e?[E('err',L.an_failed)]:[]))}
draw();W.onEvent('chatDataChanged',draw);`,
    widgetLabels(lang, ["w_an_title", "w_an_vectors", "w_an_project", "w_an_cluster", "w_an_extras", "w_an_write", "w_an_done", "w_an_failed"]),
  );

/** The analysis status message; null when Telegram refuses the widget (the old text is used). */
export const sendAnalysisStatus = async (api: Api, chatId: number, lang: Lang, llm: boolean) =>
  (await sendWidget(api, { chat_id: chatId, html: analysisPage(lang), caption: t(lang, "analysis_started"), parse_mode: "HTML", chat_data: JSON.stringify({ l: +llm }) }))?.message_id ?? null;

/** A new state of a single (not pair) analysis shown in the chat; a text status message ignores it. */
export function showAnalysis(env: Env, a: { user_id: number; pair_id: string | null; chat: number; llm: number; status_msg_id: number | null }, state: object) {
  if (a.pair_id || !a.chat || !a.status_msg_id) return;
  return editWidget(botApi(env.BOT_TOKEN), a.user_id, a.status_msg_id, JSON.stringify({ ...state, l: a.llm })).catch(() => {});
}
