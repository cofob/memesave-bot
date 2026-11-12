import { canUseAi } from "./billing";
import { MODELS } from "./config";
import { userAnalytics } from "./analytics";
import { getUser } from "./db";
import { userStats } from "./stats";
import type { Env } from "./env";
import { push } from "./live";
import { parseJson } from "./ingest/describe";
import { memeVectors } from "./ingest/embed";
import { failedReport } from "./analysisreport";
import { JobContainer } from "./job";
import { updateCard } from "./pairwidget";
import { analysisDue, showAnalysis, showAnalysisProgress } from "./analysiswidget";
import { sign, tmpKey, verify } from "./media";
import { chat } from "./openrouter";
import { analysisMoods } from "./moods";
import { pairFacts, type PairResult } from "./pairfacts";
import type { Pair } from "./pairs";
import { pairStats } from "./pairstats";
import { shareUrl } from "./analysisshare";

const PAIR_STAGES = ["vectors", "project", "cluster", "extras", "write"]; // analyze/pair.go
const DAY = 86400;
const PAGE = 2000;
const LABELED = 40; // the largest clusters get LLM names
const PAIR_MIN = 30; // ready memes of each member
export const resultKey = (id: string) => tmpKey(`analysis/${id}.json`);
export const imageKey = (id: string, name: string) => tmpKey(`analysis/${id}/${name}.png`);

export interface Cluster {
  id: number;
  size: number;
  tags: string[];
  sample: string[];
  name?: string;
  summary?: string;
}

const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clusters"],
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "summary"],
        properties: { id: { type: "integer" }, name: { type: "string" }, summary: { type: "string" } },
      },
    },
  },
};

/** Short names and one-line summaries of the largest clusters from their tags and sample memes (of `owners`): one LLM call. */
export async function labelClusters(env: Env, userId: number, clusters: Cluster[], owners = [userId]) {
  const user = await getUser(env.DB, userId);
  const top = clusters.slice(0, LABELED);
  if (!user || !top.length || !(await canUseAi(env.DB, user)).ok) return false;
  const ids = [...new Set(top.flatMap((c) => c.sample.slice(0, 5)))];
  const memes = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT id, COALESCE(title, '') || ' — ' || substr(COALESCE(description, ''), 1, 160) AS text FROM memes WHERE user_id IN (${owners.map(() => "?").join(",")}) AND id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...owners, ...chunk)
      .all<{ id: string; text: string }>();
    for (const r of results) memes.set(r.id, r.text);
  }
  const lang = user.lang === "ru" ? "Russian" : "English";
  const list = top
    .map((c) => `#${c.id} (${c.size} memes)\ntags: ${c.tags.join(", ")}\n${c.sample.slice(0, 5).flatMap((id) => memes.get(id) ?? []).map((t) => `- ${t}`).join("\n")}`)
    .join("\n\n");
  const msg = await chat(
    env,
    {
      model: MODELS.search,
      max_tokens: 60 * top.length + 200,
      reasoning: { enabled: false },
      messages: [
        {
          role: "system",
          content: `These are clusters of ${owners.length > 1 ? "two friends' joint" : "one person's"} meme collection, found by embedding similarity. For each cluster write in ${lang}: name — 2-4 words of what unites its memes (theme, template, character or format); summary — one short sentence. Reply with JSON: {"clusters": [{"id", "name", "summary"}]}`,
        },
        { role: "user", content: list },
      ],
      response_format: { type: "json_schema", json_schema: { name: "clusters", strict: true, schema: LABEL_SCHEMA } },
    },
    { userId, kind: "analysis_labels" },
  );
  const labels = parseJson<{ clusters: { id: number; name: string; summary: string }[] }>(msg.content ?? "").clusters ?? [];
  for (const c of top) {
    const l = labels.find((x) => x.id === c.id);
    if (l) Object.assign(c, { name: String(l.name).slice(0, 60), summary: String(l.summary).slice(0, 300) });
  }
  return top.some((c) => c.name);
}

/** Labels the clusters of a stored result (and writes the facts of a pair); the LLM failing only leaves them out. */
async function labelResult(env: Env, a: Analysis, result: { clusters?: Cluster[]; owners?: number[] }) {
  const warn = (e: unknown) => (console.warn("cluster labels failed", e), false);
  let ok = await labelClusters(env, a.user_id, result.clusters ?? [], result.owners).catch(warn);
  if (a.pair_id) ok = (await pairFacts(env, a, result as PairResult).catch(warn)) || ok;
  if (ok) await env.DB.prepare("UPDATE analyses SET labeled = 1 WHERE id = ?").bind(a.id).run();
  return ok;
}

export interface Analysis {
  id: string;
  user_id: number; // a pair analysis: who started and pays
  pair_id: string | null;
  status: "running" | "done" | "failed";
  stage: string | null;
  done: number;
  total: number;
  error: string | null;
  llm: number;
  labeled: number;
  chat: number;
  status_msg_id: number | null;
  created_at: number;
}

export interface StartOptions {
  llm: boolean;
  chat?: boolean; // send the report to the bot chat
  msgId?: number; // the bot message to reply to
}

/** Job container (analyze/): embedding maps, clusters and similarity stats of one user's memes. */
export class Analyzer extends JobContainer {
  sleepAfter = "2h";
  protected key = "analysisId";
  protected fail = (id: string, error: string) => failAnalysis(this.env, id, error);
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
/** The latest analysis of a user (a number) or of a pair (its id). */
export const latest = (db: D1Database, of: number | string, where = "1") =>
  db
    .prepare(`SELECT * FROM analyses WHERE ${typeof of === "number" ? "user_id = ? AND pair_id IS NULL" : "pair_id = ?"} AND ${where} ORDER BY created_at DESC LIMIT 1`)
    .bind(of)
    .first<Analysis>();

const view = (a: Analysis | null) =>
  a && {
    id: a.id,
    status: a.status,
    stage: a.stage,
    done: a.done,
    total: a.total,
    error: a.error,
    labeled: !!a.labeled,
    created_at: a.created_at,
    fresh_until: a.created_at + DAY,
  };

// A finished analysis whose charts are being redrawn (AI names added) still has its result.
export const READY = "(status = 'done' OR (status = 'running' AND stage = 'render'))";

/** The latest analysis of the user (or pair), and the latest finished one (its result is shown while a new one runs). */
export async function analysisStatus(env: Env, of: number | string) {
  const ready = view(await latest(env.DB, of, READY));
  const sid = ready && (await env.DB.prepare("SELECT id FROM analysis_shares WHERE analysis_id = ?").bind(ready.id).first<string>("id"));
  return { current: view(await latest(env.DB, of)), ready: ready && { ...ready, share: sid ? shareUrl(env, sid) : null } };
}

/**
 * Starts an analysis unless one is running or a finished one is less than a day old. A running one takes
 * over the options; a fresh finished one gets LLM names now if asked, and its report is sent to the chat.
 */
export const startAnalysis = (env: Env, userId: number, opts: StartOptions) => start(env, userId, userId, opts);

/** A pair analysis paid by `userId`: null when not an active member, "pair_too_small" under PAIR_MIN ready memes on a side. */
export async function startPairAnalysis(env: Env, pairId: string, userId: number, opts: StartOptions) {
  const p = await env.DB.prepare("SELECT * FROM pairs WHERE id = ?1 AND status = 'active' AND (a = ?2 OR b = ?2)").bind(pairId, userId).first<Pair>();
  if (!p) return null;
  const n = (id: number) => env.DB.prepare("SELECT COUNT(*) AS n FROM memes WHERE user_id = ? AND status = 'ready'").bind(id).first<number>("n");
  if (Math.min((await n(p.a))!, (await n(p.b!))!) < PAIR_MIN) return "pair_too_small";
  return start(env, pairId, userId, opts);
}

/** A fresh single result from before moods (no moods chart) is redone, when the user can pay for the mood anchors. */
async function withoutMoods(env: Env, a: Analysis, pairId: string | null) {
  if (pairId || (await env.MEDIA.head(imageKey(a.id, "moods")))) return false;
  const user = await getUser(env.DB, a.user_id);
  return !!user && (await canUseAi(env.DB, user)).ok;
}

async function start(env: Env, of: number | string, userId: number, opts: StartOptions) {
  const pairId = typeof of === "string" ? of : null;
  const recent = await latest(env.DB, of, `(status = 'running' OR (status = 'done' AND created_at > unixepoch() - ${DAY}))`);
  if (recent?.status === "running") {
    await env.DB.prepare("UPDATE analyses SET llm = MAX(llm, ?), chat = MAX(chat, ?), status_msg_id = COALESCE(?, status_msg_id) WHERE id = ?")
      .bind(+opts.llm, +!!opts.chat, opts.msgId ?? null, recent.id)
      .run();
    return view(await latest(env.DB, of));
  }
  if (recent && !(await withoutMoods(env, recent, pairId))) {
    if (opts.llm && !recent.labeled) {
      // LLM names asked for later: label the stored result, then the container redraws the charts with them.
      const obj = await env.MEDIA.get(resultKey(recent.id));
      const result = obj && (await obj.json<{ clusters?: Cluster[] }>());
      if (result && (await labelResult(env, recent, result))) {
        await env.MEDIA.put(resultKey(recent.id), JSON.stringify(result), JSON_META);
        // Pair charts are not redrawn (MODE=render draws single analyses).
        if (!pairId) {
          await env.DB.prepare(
            "UPDATE analyses SET status = 'running', stage = 'render', done = 0, total = 0, llm = 1, chat = MAX(chat, ?), status_msg_id = COALESCE(?, status_msg_id), updated_at = unixepoch() WHERE id = ?",
          )
            .bind(+!!opts.chat, opts.msgId ?? null, recent.id)
            .run();
          await launch(env, recent.id, "render");
          return view(await latest(env.DB, of));
        }
      }
    }
    if (opts.chat) await env.JOBS.send({ type: pairId ? "pair_report" : "analysis_report", analysisId: recent.id, msgId: opts.msgId, ...(pairId ? { only: userId } : {}) });
    return view(recent);
  }
  const id = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare("INSERT INTO analyses (id, user_id, pair_id, status, llm, chat, status_msg_id) VALUES (?, ?, ?, 'running', ?, ?, ?)")
    .bind(id, userId, pairId, +opts.llm, +!!opts.chat, opts.msgId ?? null)
    .run();
  await launch(env, id, pairId ? "pair" : "analyze");
  return view(await latest(env.DB, of));
}

/** Starts a container run: the full analysis (of a user or a pair), or only the charts of the stored result (a new DO per run). */
async function launch(env: Env, id: string, mode: "analyze" | "pair" | "render") {
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  const stub = env.ANALYZE.get(env.ANALYZE.idFromName(mode !== "render" ? id : `${id}:render:${Date.now()}`));
  await stub.run(id, { MODE: mode, API_URL: `${base}/analysis/${id}`, TOKEN: await sign(env, `analysis|${id}`) });
}

/** The result JSON of the latest finished analysis of the user (or pair). */
export async function analysisResult(env: Env, of: number | string) {
  const a = await latest(env.DB, of, READY);
  const obj = a && (await env.MEDIA.get(resultKey(a.id)));
  return obj ? new Response(obj.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }) : json(null, 404);
}

/** Tells the web app of the owners (both members of a pair) that the run changed. */
async function pushAnalysis(env: Env, a: Analysis) {
  const p = a.pair_id ? await env.DB.prepare("SELECT a, b FROM pairs WHERE id = ?").bind(a.pair_id).first<Pick<Pair, "a" | "b">>() : null;
  for (const id of p ? [p.a, p.b] : [a.user_id]) if (id) await push(env, id, { t: "job", kind: "analysis" });
}

/** A failed redraw keeps the finished result (with the new names, but the old charts). */
export async function failAnalysis(env: Env, id: string, error: string) {
  const a = await env.DB.prepare(
    "UPDATE analyses SET status = CASE stage WHEN 'render' THEN 'done' ELSE 'failed' END, error = ?, updated_at = unixepoch() WHERE id = ? AND status = 'running' RETURNING *",
  )
    .bind(error.slice(0, 1000), id)
    .first<Analysis>();
  if (a) await pushAnalysis(env, a);
  if (a) await showAnalysis(env, a, a.status === "failed" ? { e: 1 } : { d: 1 });
  if (a?.status === "failed" && a.chat) await failedReport(env, a);
  if (a?.status === "done" && a.chat) await env.JOBS.send({ type: a.pair_id ? "pair_report" : "analysis_report", analysisId: id });
}

const JSON_META = { httpMetadata: { contentType: "application/json" } };

/** Cron: safety net for analyses whose container never reported back. */
export const expireAnalyses = (db: D1Database) =>
  db.prepare("UPDATE analyses SET status = CASE stage WHEN 'render' THEN 'done' ELSE 'failed' END, error = 'timeout' WHERE status = 'running' AND updated_at < unixepoch() - 3 * 3600").run();

/** Container calls /analysis/<id>/<action> (per-analysis token). */
export async function handleAnalysis(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const [, , id = "", action = "", arg = ""] = url.pathname.split("/");
  const token = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const a = (await verify(env, `analysis|${id}`, token)) ? await env.DB.prepare("SELECT * FROM analyses WHERE id = ?").bind(id).first<Analysis>() : null;
  if (a?.status !== "running") return json({ error: "not running" }, 403);
  const m = req.method;
  // A pair analysis reads both members' memes only while the pair is active.
  const p = a.pair_id ? await env.DB.prepare("SELECT * FROM pairs WHERE id = ? AND status = 'active'").bind(a.pair_id).first<Pair>() : null;
  if (a.pair_id && !p && action !== "fail") return json({ error: "pair ended" }, 403);
  const owners = p ? [p.a, p.b!] : [a.user_id];

  if (action === "memes" && m === "GET") {
    // Ready memes: [id, kind, date (saved_at, else created_at), language, tags(, owner: 0 = pair.a, 1 = pair.b)], ordered by rowid.
    const rows = await env.DB.prepare(
      `SELECT rowid, id, kind, COALESCE(saved_at, created_at), language, COALESCE(tags, '')${p ? ", IIF(user_id = ?1, 0, 1)" : ""} FROM memes WHERE user_id IN (?1, ?2) AND status = 'ready' AND rowid > ?3 ORDER BY rowid LIMIT ?4`,
    )
      .bind(owners[0], owners.at(-1), Number(url.searchParams.get("after")) || 0, PAGE)
      .raw();
    return json({ rows: rows.map((r) => r.slice(1)), next: rows.length === PAGE ? rows[rows.length - 1][0] : null });
  }
  if (action === "vectors" && m === "GET") return json(await memeVectors(env, owners, url.searchParams.get("ids") ?? ""));
  if (action === "analytics" && m === "GET") {
    // The SQL stats snapshot kept in the result: the web and the bot report show the same day-old numbers.
    const user = await getUser(env.DB, a.user_id);
    if (!user) return json({ error: "no user" }, 404);
    if (p) return json({ ...(await pairStats(env, p.a, p.b!)), lang: user.lang === "ru" ? "ru" : "en" });
    const [analytics, stats] = await Promise.all([userAnalytics(env, user), userStats(env, user)]);
    return json({ ...analytics, stats, lang: user.lang === "ru" ? "ru" : "en" });
  }
  if (action === "moods" && m === "GET") {
    const moods = await analysisMoods(env, a, owners).catch((e) => (console.error("moods failed", e), null));
    return moods ? json({ moods }) : json({ error: "no moods" }, 404);
  }
  if (action === "result" && m === "GET") {
    const obj = await env.MEDIA.get(resultKey(id));
    return obj ? new Response(obj.body, { headers: { "Content-Type": "application/json" } }) : json({ error: "no result" }, 404);
  }
  if (action === "image" && m === "PUT" && /^[a-z_]{1,40}$/.test(arg) && req.body) {
    // Chart PNGs for the bot report.
    await env.MEDIA.put(imageKey(id, arg), req.body, { httpMetadata: { contentType: "image/png" } });
    return json({ ok: true });
  }
  if (action === "result" && m === "PUT") {
    const result = await req.json<{ clusters?: Cluster[]; owners?: number[] }>();
    if (p) result.owners = owners;
    if (a.llm) await labelResult(env, a, result);
    await env.MEDIA.put(resultKey(id), JSON.stringify(result), JSON_META);
    return json({ ok: true });
  }
  const body = await req.json<{ stage?: string; done?: number; total?: number; error?: string }>().catch(() => ({}) as Record<string, never>);
  if (action === "progress" && m === "POST") {
    await env.DB.prepare("UPDATE analyses SET stage = ?, done = ?, total = ?, updated_at = unixepoch() WHERE id = ?")
      .bind(body.stage ?? null, body.done ?? 0, body.total ?? 0, id)
      .run();
    await pushAnalysis(env, a);
    const r = await analysisDue(env, id);
    if (r && !p) await showAnalysisProgress(env, a, r);
    if (r && p) {
      // The pair card shows the run to both: stages in order, the current one by its done/total.
      const stage = Math.max(0, PAIR_STAGES.indexOf(r.stage ?? ""));
      await updateCard(env, p, false, Math.round((100 * (stage + (r.total ? Math.min(1, r.done / r.total) : 0))) / PAIR_STAGES.length));
    }
    return json({ ok: true });
  }
  if (action === "done" && m === "POST") {
    await env.DB.prepare("UPDATE analyses SET status = 'done', stage = 'done', updated_at = unixepoch() WHERE id = ?").bind(id).run();
    await pushAnalysis(env, a);
    if (a.chat) await env.JOBS.send({ type: a.pair_id ? "pair_report" : "analysis_report", analysisId: id });
    await showAnalysis(env, a, { d: 1 });
    if (p) await updateCard(env, p); // the new compatibility and title
    return json({ ok: true });
  }
  if (action === "fail" && m === "POST") {
    await failAnalysis(env, id, body.error ?? "unknown error");
    if (p) await updateCard(env, p); // drops the progress bar
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}
