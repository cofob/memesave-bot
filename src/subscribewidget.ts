// /subscribe as a widget: pick a plan and pay with Stars in one tap (the invoice links open in Telegram).
import { type Lang } from "./i18n";
import { page, widgetLabels } from "./widget";

/** State: {p: [[kind "m"|"y", price, stars, invoice link, saving % | null]], i: what is included, st: plan status}. */
export const subscribePage = (lang: Lang) =>
  page(
    ".plans{display:grid;grid-template-columns:1fr 1fr;gap:var(--cf-space-2)}.plan{border:2px solid transparent;border-radius:var(--cf-radius-lg);background:var(--cf-color-surface);color:var(--cf-color-text);font:inherit;text-align:left;padding:var(--cf-space-2) var(--cf-space-3);display:flex;flex-direction:column;gap:2px}.plan.on{border-color:var(--cf-color-accent)}.plan .big{font-size:1.375rem}.badge{color:var(--cf-color-accent);font-size:.8125rem;font-weight:600}",
    "<div id=r style='display:flex;flex-direction:column;gap:var(--cf-space-3)'></div>",
    `let sel=0;
function draw(){const s=S()||{},p=s.p||[];if(!p.length)return;const ps=E('plans');
R(ps,...p.map(([k,usd,stars,,sv],i)=>{const b=E(i==sel?'plan on':'plan','','button'),h=E('row sp');R(h,E('title',k=='m'?L.month:L.year,'span'),...(sv?[E('badge','−'+sv+'%','span')]:[]));
R(b,h,E('big',usd,'span'),E('muted',stars+' ⭐ · '+(k=='m'?L.renews:L.for_year),'span'));b.onclick=()=>{sel=i;draw()};return b}));
const pay=E('primary',L.pay.replace('{n}',p[sel][2]),'button');pay.onclick=()=>W.openTelegramLink(p[sel][3]);
R($('r'),ps,E('muted',s.i),pay,...(s.st?[E('muted',s.st)]:[]))}
draw();W.onEvent('chatDataChanged',draw);`,
    widgetLabels(lang, ["w_month", "w_year", "w_renews", "w_for_year", "w_pay"]),
  );
