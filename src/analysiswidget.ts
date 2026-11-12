// The collection analysis as a widget: its stages with the progress of the current one; the report follows as messages.
import type { Api } from "grammy";
import { botApi } from "./botapi";
import type { Env } from "./env";
import { t, type Lang } from "./i18n";
import { editWidget, page, progressApi, sendWidget, widgetLabels } from "./widget";

const STAGES = ["vectors", "project", "cluster", "extras"]; // analyze/main.go and analyze/analyze.go
// Rough shares of the run time: loading vectors dominates; "write" (AI names) only with llm and without reports.
const WEIGHTS = { vectors: 50, project: 25, cluster: 10, extras: 15, write: 20 };

/** State: {s: stage, p: its progress %, l: 1 with AI names (one more step), d: 1 done, e: 1 failed}. */
export const analysisPage = (lang: Lang) =>
  page(
    ".steps{display:flex;flex-direction:column;gap:6px}.ic{width:1.25rem;text-align:center;color:var(--cf-color-text-subtle)}.ok .ic{color:var(--cf-color-accent)}.now{font-weight:600}.wait{color:var(--cf-color-text-subtle)}.err{color:var(--cf-color-danger)}",
    "<div id=r style='display:flex;flex-direction:column;gap:var(--cf-space-2)'></div>",
    `const ST=${JSON.stringify(STAGES)},WT=${JSON.stringify(WEIGHTS)},sum=a=>a.reduce((x,k)=>x+WT[k],0);
function draw(){const s=S()||{},ks=[...ST,...(s.l?['write']:[])],x=ks.indexOf(s.s),p=s.p||0;
// cur: the first unfinished step (a stage at 100% is finished); fr: its share done; an unknown stage (render) is the last step.
const cur=s.d?ks.length:x<0?(s.s?ks.length-1:0):x+(p>=100?1:0),fr=!s.d&&x>=0&&cur==x?p/100:0,all=s.d?100:Math.min(99,100*(sum(ks.slice(0,cur))+(ks[cur]?WT[ks[cur]]*fr:0))/sum(ks));
const h=E('row sp');R(h,E('title',L.an_title,'span'),E('muted',Math.round(all)+'%','span'));
const tr=E('track'),f=E('fill');f.style.width=all+'%';tr.appendChild(f);
const st=E('steps');ks.forEach((k,j)=>{const r=E(j<cur?'row ok':j==cur?'row now':'row wait');
R(r,E('ic',j<cur?'✓':j==cur?'●':'○','span'),E('ell',L['an_'+k],'span'));if(j==cur&&fr)r.appendChild(E('muted',Math.round(fr*100)+'%','span'));st.appendChild(r)});
R($('r'),h,tr,st,...(s.d?[E('muted',L.an_done)]:s.e?[E('err',L.an_failed)]:[]))}
draw();W.onEvent('chatDataChanged',draw);`,
    widgetLabels(lang, ["w_an_title", "w_an_vectors", "w_an_project", "w_an_cluster", "w_an_extras", "w_an_write", "w_an_done", "w_an_failed"]),
  );

/** The analysis status message; null when Telegram refuses the widget (the old text is used). */
export const sendAnalysisStatus = async (api: Api, chatId: number, lang: Lang, llm: boolean) =>
  (await sendWidget(api, { chat_id: chatId, html: analysisPage(lang), caption: t(lang, "analysis_started"), parse_mode: "HTML", chat_data: JSON.stringify({ l: +llm }) }))?.message_id ?? null;

type Shown = { user_id: number; pair_id: string | null; chat: number; llm: number; status_msg_id: number | null };

export type Progress = { stage: string | null; done: number; total: number };

/**
 * The latest progress of an analysis when its widgets are due an edit (at most every 5 s), else null. The latest from
 * the database, not the report's: an edit that lands late never moves the bar back.
 */
export const analysisDue = (env: Env, id: string) =>
  env.DB.prepare(
    "UPDATE analyses SET widget_at = unixepoch() WHERE id = ? AND (widget_at IS NULL OR widget_at <= unixepoch() - 5) RETURNING stage, done, total",
  )
    .bind(id)
    .first<Progress>();

/** The progress of a single analysis (see analysisDue), without waiting on a 429 (see progressApi). */
export async function showAnalysisProgress(env: Env, a: Shown, r: Progress) {
  if (a.pair_id || !a.chat || !a.status_msg_id) return;
  const state = { s: r.stage, p: r.total ? Math.round((100 * Math.min(1, r.done / r.total))) : 0, l: a.llm };
  await editWidget(progressApi(env.BOT_TOKEN), a.user_id, a.status_msg_id, JSON.stringify(state)).catch(() => {});
}

/** A new state of a single (not pair) analysis shown in the chat; a text status message ignores it. */
export function showAnalysis(env: Env, a: Shown, state: object) {
  if (a.pair_id || !a.chat || !a.status_msg_id) return;
  return editWidget(botApi(env.BOT_TOKEN), a.user_id, a.status_msg_id, JSON.stringify({ ...state, l: a.llm })).catch(() => {});
}
