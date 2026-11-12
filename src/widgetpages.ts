// Widget pages: markup and scripts for each widget; the bot sends them with sendWidget and changes only their state.
import { dict, t, type Key, type Lang } from "./i18n";
import { page } from "./widget";

/** Labels by key without the "w_" prefix. */
const labels = (lang: Lang, keys: Key[]) => Object.fromEntries(keys.map((k) => [k.slice(2), t(lang, k)]));

/** Import progress (zip; `saving` and `skipped` are the labels of other imports). State: {f: found, t: total, k: skipped, d: done, e: 1 when finished}. */
export const progressPage = (lang: Lang, saving: Key = "w_saving", skipped: Key = "w_skipped") =>
  page(
    "",
    "<div class='row sp'><span class='title ell' id=h></span><span class='title accent' id=p></span></div><div class=track><div class=fill id=b></div></div><div id=t></div>",
    `function draw(){const s=S()||{},v=s.t?Math.min(100,100*s.d/s.t):s.e?100:0;$('h').textContent=s.e?L.done:L.saving;$('p').textContent=Math.round(v)+'%';$('b').style.width=v+'%';
R($('t'),K(T(L.saved,(s.d??0)+'/'+(s.t??0)),T(L.found,s.f),T(L.skipped,s.k)))}
draw();W.onEvent('chatDataChanged',draw);`,
    { ...labels(lang, ["w_done", "w_saved", "w_found"]), saving: t(lang, saving), skipped: t(lang, skipped) },
  );

/** /stats card. State: {m: memes, z: storage, c: AI spend 30 d, d: saves per day (30, oldest first), g: [[tag, count]]}. */
export const statsPage = (lang: Lang) =>
  page(
    ".bars .bg{fill:var(--cf-color-surface)}.bars .v{fill:var(--cf-color-accent)}.hb{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--cf-space-2) var(--cf-space-3)}.hb .track{height:4px;margin-top:2px}",
    "<div id=t></div><div class='row sp'><div class=seg id=tb></div><button class=icon id=r>↻</button></div><div id=c></div>",
    `let tab=0;
const bars=d=>{const m=Math.max(1,...d),w=300/d.length;return '<svg class=bars viewBox="0 0 300 72" width="100%" height="72" preserveAspectRatio="none">'+d.map((v,i)=>{const x=i*w+1.5,h=v?Math.max(3,v/m*72):0;return '<rect class=bg rx="2" x="'+x+'" y="0" width="'+(w-3)+'" height="72"/><rect class=v rx="2" x="'+x+'" y="'+(72-h)+'" width="'+(w-3)+'" height="'+h+'"/>'}).join('')+'</svg>'};
const axis=()=>{const a=E('row sp muted');R(a,E('',L.ago,'span'),E('',L.today,'span'));return a};
const tags=g=>{const b=E('hb');g.forEach(([n,v])=>{const r=E(''),h=E('row sp'),tr=E('track'),f=E('fill');R(h,E('ell',n,'span'),E('muted',v,'span'));f.style.width=100*v/g[0][1]+'%';tr.appendChild(f);R(r,h,tr);b.appendChild(r)});return b};
function draw(){const s=S()||{};R($('t'),K(T(L.memes,s.m),T(L.storage,s.z),T(L.spend30,s.c)));
R($('tb'),...[L.days,L.tags].map((l,i)=>{const b=E(i==tab?'on':'',l,'button');b.onclick=()=>{tab=i;draw()};return b}));
const c=$('c');if(tab)R(c,s.g&&s.g.length?tags(s.g):E('muted',L.empty));else{c.innerHTML=bars(s.d&&s.d.length?s.d:[0]);c.appendChild(axis())}}
const r=$('r');r.onclick=()=>{r.disabled=true;W.request('s').catch(()=>{}).then(()=>{r.disabled=false})};
draw();W.onEvent('chatDataChanged',draw);`,
    labels(lang, ["w_memes", "w_storage", "w_spend30", "w_days", "w_tags", "w_empty", "w_ago", "w_today"]),
  );

/** /balance card. State: {s: plan status, b: balance, l: allowance left, a: allowance, r: left share 0..1}. */
export const balancePage = (lang: Lang) =>
  page(
    "",
    "<div class=col><span class=muted id=bl></span><span class=big id=b></span><span class=muted id=s></span></div><div class=col style='gap:6px'><div class='row sp muted'><span id=al></span><span id=l></span></div><div class=track><div class=fill id=f></div></div></div>",
    `$('bl').textContent=L.balance;$('al').textContent=L.allowance;
function draw(){const s=S()||{};$('b').textContent=s.b??'–';$('s').textContent=s.s??'';$('l').textContent=(s.l??'–')+' / '+(s.a??'–');$('f').style.width=100*(s.r??0)+'%'}
draw();W.onEvent('chatDataChanged',draw);`,
    labels(lang, ["w_balance", "w_allowance"]),
  );

const PAIR_KEYS: Key[] = ["w_compat", "w_twins", "w_shared_tags", "w_pair_ended", "w_tab_main", "w_tab_moods", "w_tab_awards", "w_tab_hours", "w_loading", "w_run", "w_no_moods", "w_analyzing"];
/** Labels of every language: one shared widget serves both sides, each in its own language (chat state l). */
const allLabels = (keys: Key[]) => Object.fromEntries((Object.keys(dict) as Lang[]).map((lang) => [lang, labels(lang, keys)]));
// The viewer's side: x, y names; l labels. Shared by the pair pages.
const SIDE = `const side=()=>{const p=P()||{},c=S()||{},b=c.me==='b';return{p,l:L[c.l]||L.en,b,x:b?p.bn:p.an,y:b?p.an:p.bn}};`;
const LINE_CSS = ".l1,.l2{fill:none;stroke-width:2}.l1{stroke:var(--cf-color-accent)}.l2{stroke:var(--cf-color-text-subtle)}.em{display:flex;gap:2px;font-size:.9rem}";

/**
 * Pair card, one shared widget for both chats. Shared state: {id, an, bn: names, m: compatibility %, ra, rb: memes,
 * s: same memes (only when both share), tg: shared tags, ti: {lang: title} of the AI analysis, pr: analysis progress %, v: 0 when ended}.
 * Chat state: {me: "a" | "b", l: language}. The other tabs ask the bot (pt:<id>:m|w|h) and get the viewer's side first:
 * m {x, y: mood emoji per month, s: similarity % per month, n: moods of the year}, w {t: title, w: [[award, winner, reason]]},
 * h {a, b: % per UTC hour}; {e: 1} without an analysis, {e: 2} without moods.
 */
export const pairPage = () =>
  page(
    `.big{font-size:2.5rem}${LINE_CSS}`,
    "<div id=r style='display:flex;flex-direction:column;gap:var(--cf-space-3)'></div>",
    `${SIDE}let tab=0;const C={};
const svg=(...v)=>{const m=Math.max(1,...v.flat().filter(x=>x!=null));return '<svg viewBox="0 0 300 64" width="100%" height="64" preserveAspectRatio="none">'+v.map((s,j)=>'<polyline class=l'+(j+1)+' points="'+s.map((y,i)=>(i*300/Math.max(1,s.length-1)).toFixed(0)+','+(62-(y??0)*60/m).toFixed(0)).join(' ')+'"/>').join('')+'</svg>'};
const leg=(x,y)=>{const e=E('row sp muted');R(e,E('accent',x,'span'),E('',y,'span'));return e};
const em=a=>{const e=E('em');(a||[]).forEach(x=>e.appendChild(E('',x||'·','span')));return e};
function main(o,{p,l,b,x,y}){const n=E('col');R(n,E('title ell',x+' + '+y),E('muted',p.ti&&p.ti[S()?.l]||l.compat));
const h=E('row');h.style.gap='var(--cf-space-3)';R(h,E('big accent',(p.m??0)+'%'),n);o.push(h);
if(p.pr!=null){const t=E('track'),f=E('fill');f.style.width=p.pr+'%';t.appendChild(f);o.push(E('muted',l.analyzing+' '+p.pr+'%'),t)}
o.push(K(T(x,b?p.rb:p.ra),T(y,b?p.ra:p.rb),...(p.s!=null?[T(l.twins,p.s)]:[])));
if(p.tg&&p.tg.length){const t=E('col');t.style.gap='6px';const ch=E('chips');R(ch,...p.tg.map(g=>E('chip',g,'span')));R(t,E('muted',l.shared_tags),ch);o.push(t)}}
function more(o,d,{l,x,y}){if(!d)return o.push(E('muted',l.loading));if(d.e)return o.push(E('muted',d.e==2?l.no_moods:l.run));
if(tab==1){o.push(leg(x+' '+(d.n?.[0]||''),y+' '+(d.n?.[1]||'')),em(d.x),em(d.y),E('html',''));o[o.length-1].innerHTML=svg(d.s||[])}
if(tab==2){if(d.t)o.push(E('title',d.t));(d.w||[]).forEach(([a,w,r])=>{const e=E('col');R(e,E('ell',a+' · '+w,'b'),E('muted',r));o.push(e)})}
if(tab==3){o.push(leg(x,y),E('',''));o[o.length-1].innerHTML=svg(d.a||[],d.b||[])}}
function draw(){const s=side(),o=[];if(s.p.v===0){const n=E('col');R(n,E('title ell',s.x+' + '+s.y),E('muted',s.l.pair_ended));return R($('r'),n)}
const g=E('seg');[s.l.tab_main,s.l.tab_moods,s.l.tab_awards,s.l.tab_hours].forEach((t,i)=>{const b=E(i==tab?'on':'',t,'button');
b.onclick=()=>{tab=i;if(i&&!C[i])W.request('pt:'+s.p.id+':'+'mwh'[i-1]).then(a=>{C[i]=J(a.result)||{e:1};draw()},()=>{});draw()};g.appendChild(b)});o.push(g);
tab?more(o,C[tab],s):main(o,s);R($('r'),...o)}
draw();W.watchPublicData();W.onEvent('publicDataChanged',()=>{for(const k in C)delete C[k];draw()});W.onEvent('chatDataChanged',draw);`,
    allLabels(PAIR_KEYS),
  );

const QUIZ_KEYS: Key[] = ["w_quiz", "w_quiz_start", "w_quiz_mine", "w_quiz_right", "w_quiz_wrong", "w_quiz_streak", "w_quiz_noshare"];

/**
 * "Whose meme?" duel, one shared widget per pair. Shared state: {id, an, bn: names, sa, ta, sb, tb: right answers / answers}.
 * Chat state: {me, l}. Requests pq:<id>:n (a question), pq:<id>:m|p (the answer: mine / the partner's) get
 * {c: 1 | 0 when answered, q: {t: title, g: tags, y: year} the next question, e: 1 when the partner hides their memes}.
 */
export const quizPage = () =>
  page(
    ".btn{flex:1;border:0;border-radius:var(--cf-radius-md);background:var(--cf-color-accent);color:var(--cf-color-accent-contrast);font:inherit;font-weight:600;padding:var(--cf-space-2)}.q{background:var(--cf-color-surface);border-radius:var(--cf-radius-lg);padding:var(--cf-space-3)}",
    "<div id=r style='display:flex;flex-direction:column;gap:var(--cf-space-3)'></div>",
    `${SIDE}let q=null,c=null,st=0,e=0;
const btn=(t,k)=>{const b=E('btn',t,'button');b.onclick=()=>W.request('pq:'+side().p.id+':'+k).then(a=>{const d=J(a.result)||{};e=d.e||0;q=d.q||null;
if(d.c!=null){c=d.c;st=c?st+1:0;try{W.HapticFeedback.notificationOccurred(c?'success':'error')}catch(x){}}draw()},()=>{});return b};
function draw(){const{p,l,b,x,y}=side(),o=[E('title',l.quiz)],v=(s,t)=>(s??0)+'/'+(t??0);
o.push(K(T(x,b?v(p.sb,p.tb):v(p.sa,p.ta)),T(y,b?v(p.sa,p.ta):v(p.sb,p.tb)),T(l.quiz_streak,String(st))));
if(c!=null)o.push(E(c?'accent':'muted',c?l.quiz_right:l.quiz_wrong));
const r=E('row');if(e)o.push(E('muted',l.quiz_noshare));else if(!q)R(r,btn(l.quiz_start,'n'));
else{const k=E('q col');R(k,E('title',q.t),E('muted',[q.g,q.y].filter(Boolean).join(' · ')));o.push(k);R(r,btn(l.quiz_mine,'m'),btn(y,'p'))}
o.push(r);R($('r'),...o)}
draw();W.watchPublicData();W.onEvent('publicDataChanged',draw);W.onEvent('chatDataChanged',draw);`,
    allLabels(QUIZ_KEYS),
  );

/** /pair list. Chat state: {p: [[pair id, name, compatibility % | null]]}; a tap asks the bot for that pair's card (pc:<id>). */
export const pairsListPage = (lang: Lang) =>
  page(
    "button.it{border:0;background:none;color:inherit;font:inherit;text-align:start;padding:0;display:flex;flex-direction:column;gap:4px}",
    "<span class=title id=h></span><div class=col id=l style='gap:var(--cf-space-3)'></div>",
    `$('h').textContent=L.pairs;
function draw(){const s=S()||{};R($('l'),...(s.p||[]).map(([id,n,m])=>{const b=E('it',null,'button'),h=E('row sp'),t=E('track'),f=E('fill');
R(h,E('ell',n,'span'),E('muted',m==null?'–':m+'%','span'));f.style.width=(m??0)+'%';t.appendChild(f);R(b,h,t);
b.onclick=()=>{b.disabled=true;W.request('pc:'+id).catch(()=>{}).then(()=>{b.disabled=false})};return b}))}
draw();W.onEvent('chatDataChanged',draw);`,
    labels(lang, ["w_pairs"]),
  );
