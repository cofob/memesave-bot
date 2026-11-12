// Pair widgets (src/widget.ts): the shared card with tabs and the analysis progress, the "Whose meme?" duel, the /pair list.
import type { InlineKeyboardButton } from "grammy/types";
import { analysisResult } from "./analysis";
import { langOfUser } from "./billing";
import { botApi } from "./botapi";
import type { User } from "./db";
import type { Env } from "./env";
import { esc, t, type Lang } from "./i18n";
import type { PairResult } from "./pairfacts";
import type { Pair } from "./pairs";
import { pairStats } from "./pairstats";
import { editSharedWidget, sendSharedWidget, sendWidget, type WidgetQuery } from "./widget";
import { pairPage, pairsListPage, quizPage } from "./widgetpages";

export const statsButton = (env: Env, text: string, id: string): InlineKeyboardButton => ({ text, web_app: { url: `${env.PUBLIC_URL.replace(/\/$/, "")}/?pair=${id}` } });

/** A short hash of a page: a sent widget keeps its HTML, so a new page needs a new shared widget. */
const rev = (html: string) => {
  let h = 0;
  for (let i = 0; i < html.length; i++) h = (h * 31 + html.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
export const CARD_REV = rev(pairPage());

const bytes = (s: string) => new TextEncoder().encode(s).length;
const names = (p: Pair) => ({ an: (p.a_name ?? "?").slice(0, 20), bn: (p.b_name ?? "?").slice(0, 20) });
const latestResult = async (env: Env, pairId: string) => (await analysisResult(env, pairId)).json<PairResult | null>().catch(() => null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The shared card state, the same in both chats: same memes only when both share, just the names once ended. */
async function cardState(env: Env, p: Pair, ended = false) {
  if (ended) return { ...names(p), v: 0 };
  const [st, r] = await Promise.all([pairStats(env, p.a, p.b!), latestResult(env, p.id)]);
  const m = r?.scores.compat ?? st.compat; // the analysis compatibility once there is one
  if (m !== p.compat) await env.DB.prepare("UPDATE pairs SET compat = ? WHERE id = ?").bind(m, p.id).run();
  const ti = r?.facts && Object.fromEntries(Object.entries(r.facts).map(([l, f]) => [l, f!.title.slice(0, 60)]));
  const both = p.a_shares && p.b_shares;
  const tg = both ? st.shared.tags.slice(0, 3).map((x) => x.tag.slice(0, 20)) : [];
  return { id: p.id, ...names(p), m, ra: st.me.ready, rb: st.partner.ready, s: both ? st.shared.twins.count : undefined, tg, ti, v: 1 };
}

// Per isolate: the last card state (progress ticks reuse it) and its edit time (Telegram: one edit per second per shared widget).
const last = new Map<string, { state: object; at: number }>();

/** Refreshes the card in every chat that shows it; pr: the running analysis progress in %. */
export async function updateCard(env: Env, p: Pair, ended = false, pr?: number) {
  if (!p.widget_id) return;
  const prev = last.get(p.id);
  const dt = prev ? Date.now() - prev.at : Infinity;
  if (pr != null && dt < 1500) return;
  if (dt < 1100) await sleep(1100 - dt); // the final state must not be dropped by the rate limit
  const state = pr != null && prev ? prev.state : await cardState(env, p, ended);
  last.set(p.id, { state, at: Date.now() });
  await editSharedWidget(botApi(env.BOT_TOKEN), p.widget_id, JSON.stringify(pr != null ? { ...state, pr } : state)).catch(console.error);
}

const chatData = (p: Pair, userId: number, lang: Lang) => JSON.stringify({ me: userId === p.a ? "a" : "b", l: lang });

/** Sends the pair card to one side: the first send (or a new page version) creates the shared widget, later ones show it. */
export async function sendCard(env: Env, p: Pair, userId: number, lang: Lang) {
  const api = botApi(env.BOT_TOKEN);
  const partner = (userId === p.a ? p.b_name : p.a_name) ?? "?";
  const extra = { chat_data: chatData(p, userId, lang), reply_markup: { inline_keyboard: [[statsButton(env, t(lang, "pair_btn_stats", { name: partner }), p.id)]] } };
  const state = await cardState(env, p);
  const caption = t(lang, "w_pair_caption", { a: esc(state.an), b: esc(state.bn), compat: "m" in state ? state.m : 0 });
  if (p.widget_id && p.widget_rev === CARD_REV) return sendSharedWidget(api, userId, p.widget_id, { ...extra, caption, parse_mode: "HTML" });
  const sent = await sendWidget(api, { chat_id: userId, html: pairPage(), caption, parse_mode: "HTML", public_data: JSON.stringify(state), is_shared: true, allow_queries: true, ...extra });
  p.widget_id = sent?.widget?.id ?? null;
  p.widget_rev = CARD_REV;
  if (p.widget_id) await env.DB.prepare("UPDATE pairs SET widget_id = ?, widget_rev = ? WHERE id = ?").bind(p.widget_id, CARD_REV, p.id).run();
  return sent;
}

const hours = (cells: { h: number; n: number }[]) => {
  const v = Array<number>(24).fill(0);
  for (const c of cells) v[c.h] += c.n;
  const sum = v.reduce((a, x) => a + x, 0) || 1;
  return v.map((x) => Math.round((100 * x) / sum));
};

/** A card tab for the viewer, their side first: h hours, m moods, w awards (see pairPage). */
async function tabQuery(env: Env, p: Pair, me: number, lang: Lang, tab: string) {
  if (tab === "h") {
    const st = await pairStats(env, me, me === p.a ? p.b! : p.a);
    return { a: hours(st.me.heatmap), b: hours(st.partner.heatmap) };
  }
  const r = await latestResult(env, p.id);
  if (!r) return { e: 1 };
  const side = me === p.a ? 0 : 1;
  if (tab === "m") {
    const md = r.moods;
    if (!md) return { e: 2 };
    const label = md.names[lang] ?? md.names.en ?? md.keys;
    const strip = (rows: (number[] | null)[]) => rows.map((row) => (row ? md.emoji[row.indexOf(Math.max(...row))] : ""));
    const top = (o: number) => (md.top[o] >= 0 ? `${md.emoji[md.top[o]]} ${label[md.top[o]]}` : "");
    const rows = [md.a, md.b];
    return { x: strip(rows[side]), y: strip(rows[1 - side]), s: md.sim.map((v) => (v == null ? null : Math.round(100 * v))), n: [top(side), top(1 - side)] };
  }
  const f = r.facts?.[lang] ?? Object.values(r.facts ?? {})[0];
  if (!f) return { e: 1 };
  const n = names(p);
  const winner = (w: string) => (w === "both" ? t(lang, "w_both") : w === "a" ? n.an : n.bn);
  const out = { t: f.title.slice(0, 80), w: f.awards.slice(0, 5).map((x) => [x.name.slice(0, 40), winner(x.winner), x.reason.slice(0, 110)]) };
  while (bytes(JSON.stringify(out)) > 1024) out.w.pop(); // an answer carries at most 1024 bytes
  return out;
}

const quizState = async (env: Env, p: Pair) => {
  const { results } = await env.DB.prepare("SELECT user_id, score, total FROM pair_quiz WHERE pair_id = ?").bind(p.id).all<{ user_id: number; score: number; total: number }>();
  const of = (id: number | null) => results.find((r) => r.user_id === id);
  return { id: p.id, ...names(p), sa: of(p.a)?.score, ta: of(p.a)?.total, sb: of(p.b)?.score, tb: of(p.b)?.total };
};

/** Sends the duel to one side: one shared widget per pair, so both see the same score. */
export async function sendQuiz(env: Env, p: Pair, userId: number, lang: Lang) {
  const api = botApi(env.BOT_TOKEN);
  const n = names(p);
  const extra = { chat_data: chatData(p, userId, lang), caption: t(lang, "w_quiz_caption", { a: esc(n.an), b: esc(n.bn) }), parse_mode: "HTML" as const };
  if (p.quiz_id) return sendSharedWidget(api, userId, p.quiz_id, extra);
  const sent = await sendWidget(api, { chat_id: userId, html: quizPage(), public_data: JSON.stringify(await quizState(env, p)), is_shared: true, allow_queries: true, ...extra });
  if (sent?.widget?.id) await env.DB.prepare("UPDATE pairs SET quiz_id = ? WHERE id = ?").bind(sent.widget.id, p.id).run();
  return sent;
}

/** A random ready meme of one side (a coin picks it) that the other side does not have; none while the partner hides theirs. */
async function question(env: Env, p: Pair, me: number) {
  const partner = me === p.a ? p.b! : p.a;
  if (!(me === p.a ? p.b_shares : p.a_shares)) return null;
  for (const owner of Math.random() < 0.5 ? [me, partner] : [partner, me]) {
    const m = await env.DB.prepare(
      `SELECT id, title, tags, COALESCE(saved_at, created_at) AS d FROM memes m WHERE user_id = ?1 AND status = 'ready' AND porn = 0 AND title IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM memes o WHERE o.user_id = ?2 AND o.file_unique_id = m.file_unique_id)
       AND NOT EXISTS (SELECT 1 FROM memes o WHERE o.user_id = ?2 AND o.sha256 = m.sha256) ORDER BY random() LIMIT 1`,
    )
      .bind(owner, owner === me ? partner : me)
      .first<{ id: string; title: string; tags: string | null; d: number }>();
    if (m) return m;
  }
  return null;
}

/** n: a question; m | p: the answer to the stored one (mine / the partner's), checked here, then the next question. */
async function quizQuery(env: Env, p: Pair, me: number, k: string) {
  const asked = await env.DB.prepare("SELECT meme_id FROM pair_quiz WHERE pair_id = ? AND user_id = ?").bind(p.id, me).first<string | null>("meme_id");
  const owner = (k === "m" || k === "p") && asked ? await env.DB.prepare("SELECT user_id FROM memes WHERE id = ?").bind(asked).first<number>("user_id") : null;
  const c = owner == null ? undefined : +((owner === me) === (k === "m"));
  const q = await question(env, p, me);
  await env.DB.prepare(
    `INSERT INTO pair_quiz (pair_id, user_id, meme_id, score, total) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT DO UPDATE SET meme_id = ?3, score = score + ?4, total = total + ?5`,
  )
    .bind(p.id, me, q?.id ?? null, c ?? 0, c == null ? 0 : 1)
    .run();
  if (c != null && p.quiz_id) await editSharedWidget(botApi(env.BOT_TOKEN), p.quiz_id, JSON.stringify(await quizState(env, p))).catch(console.error);
  if (!q) return { c, e: 1 };
  const g = (q.tags ?? "").split("\n").filter(Boolean).slice(0, 3).join(", ").slice(0, 60);
  return { c, q: { t: q.title.slice(0, 90), g, y: new Date(q.d * 1000).getUTCFullYear() } };
}

/** The /pair list as a widget: active pairs with their last compatibility; null when there are none or Telegram refuses it. */
export async function sendPairsList(env: Env, userId: number, lang: Lang) {
  const { results } = await env.DB.prepare("SELECT * FROM pairs WHERE status = 'active' AND (a = ?1 OR b = ?1) ORDER BY accepted_at DESC LIMIT 20").bind(userId).all<Pair>();
  const p = results.map((x) => [x.id, ((x.a === userId ? x.b_name : x.a_name) ?? "?").slice(0, 16), x.compat]);
  while (bytes(JSON.stringify({ p })) > 1024) p.pop();
  if (!p.length) return null;
  return sendWidget(botApi(env.BOT_TOKEN), { chat_id: userId, html: pairsListPage(lang), caption: t(lang, "w_pairs_caption"), chat_data: JSON.stringify({ p }), allow_queries: true });
}

/** Requests of the pair widgets: pt:<id>:<m|w|h>, pq:<id>:<n|m|p>, pc:<id>. The answer data; undefined when it is not the user's pair. */
export async function pairQuery(env: Env, q: WidgetQuery, user: User) {
  const [kind, id, arg = ""] = q.data.split(":");
  const p = await env.DB.prepare("SELECT * FROM pairs WHERE id = ?1 AND status = 'active' AND (a = ?2 OR b = ?2)").bind(id, user.id).first<Pair>();
  if (!p) return;
  const lang = langOfUser(user);
  if (kind === "pt" && "mwh".includes(arg) && arg) return JSON.stringify(await tabQuery(env, p, user.id, lang, arg));
  if (kind === "pq" && "nmp".includes(arg) && arg) return JSON.stringify(await quizQuery(env, p, user.id, arg));
  if (kind === "pc") await sendCard(env, p, user.id, lang);
}
