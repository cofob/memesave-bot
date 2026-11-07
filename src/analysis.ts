import { canUseAi } from "./billing";
import { MODELS } from "./config";
import { userAnalytics } from "./analytics";
import { getUser } from "./db";
import { userStats } from "./stats";
import type { Env } from "./env";
import { parseJson } from "./ingest/describe";
import { memeVectors } from "./ingest/embed";
import { failedReport } from "./analysisreport";
import { JobContainer } from "./job";
import { sign, tmpKey, verify } from "./media";
import { chat } from "./openrouter";

const DAY = 86400;
const PAGE = 2000;
const LABELED = 40; // the largest clusters get LLM names
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

/** Short names and one-line summaries of the largest clusters from their tags and sample memes: one LLM call. */
export async function labelClusters(env: Env, userId: number, clusters: Cluster[]) {
  const user = await getUser(env.DB, userId);
  const top = clusters.slice(0, LABELED);
  if (!user || !top.length || !(await canUseAi(env.DB, user)).ok) return false;
  const ids = [...new Set(top.flatMap((c) => c.sample.slice(0, 5)))];
  const memes = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT id, COALESCE(title, '') || ' — ' || substr(COALESCE(description, ''), 1, 160) AS text FROM memes WHERE user_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(userId, ...chunk)
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
          content: `These are clusters of one person's meme collection, found by embedding similarity. For each cluster write in ${lang}: name — 2-4 words of what unites its memes (theme, template, character or format); summary — one short sentence. Reply with JSON: {"clusters": [{"id", "name", "summary"}]}`,
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

/** Labels the clusters of a stored result; the LLM failing only leaves them out. */
async function labelResult(env: Env, a: Analysis, result: { clusters?: Cluster[] }) {
  const ok = await labelClusters(env, a.user_id, result.clusters ?? []).catch((e) => (console.warn("cluster labels failed", e), false));
  if (ok) await env.DB.prepare("UPDATE analyses SET labeled = 1 WHERE id = ?").bind(a.id).run();
  return ok;
}

export interface Analysis {
  id: string;
  user_id: number;
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
const latest = (db: D1Database, userId: number, where = "1") =>
  db.prepare(`SELECT * FROM analyses WHERE user_id = ? AND ${where} ORDER BY created_at DESC LIMIT 1`).bind(userId).first<Analysis>();

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
const READY = "(status = 'done' OR (status = 'running' AND stage = 'render'))";

/** The latest analysis of the user, and the latest finished one (its result is shown while a new one runs). */
export async function analysisStatus(env: Env, userId: number) {
  return { current: view(await latest(env.DB, userId)), ready: view(await latest(env.DB, userId, READY)) };
}

/**
 * Starts an analysis unless one is running or a finished one is less than a day old. A running one takes
 * over the options; a fresh finished one gets LLM names now if asked, and its report is sent to the chat.
 */
export async function startAnalysis(env: Env, userId: number, opts: StartOptions) {
  const recent = await latest(env.DB, userId, `(status = 'running' OR (status = 'done' AND created_at > unixepoch() - ${DAY}))`);
  if (recent?.status === "running") {
    await env.DB.prepare("UPDATE analyses SET llm = MAX(llm, ?), chat = MAX(chat, ?), status_msg_id = COALESCE(?, status_msg_id) WHERE id = ?")
      .bind(+opts.llm, +!!opts.chat, opts.msgId ?? null, recent.id)
      .run();
    return view(await latest(env.DB, userId));
  }
  if (recent) {
    if (opts.llm && !recent.labeled) {
      // LLM names asked for later: label the stored result, then the container redraws the charts with them.
      const obj = await env.MEDIA.get(resultKey(recent.id));
      const result = obj && (await obj.json<{ clusters?: Cluster[] }>());
      if (result && (await labelResult(env, recent, result))) {
        await env.MEDIA.put(resultKey(recent.id), JSON.stringify(result), JSON_META);
        await env.DB.prepare(
          "UPDATE analyses SET status = 'running', stage = 'render', done = 0, total = 0, llm = 1, chat = MAX(chat, ?), status_msg_id = COALESCE(?, status_msg_id), updated_at = unixepoch() WHERE id = ?",
        )
          .bind(+!!opts.chat, opts.msgId ?? null, recent.id)
          .run();
        await launch(env, recent.id, "render");
        return view(await latest(env.DB, userId));
      }
    }
    if (opts.chat) await env.JOBS.send({ type: "analysis_report", analysisId: recent.id, msgId: opts.msgId });
    return view(recent);
  }
  const id = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare("INSERT INTO analyses (id, user_id, status, llm, chat, status_msg_id) VALUES (?, ?, 'running', ?, ?, ?)")
    .bind(id, userId, +opts.llm, +!!opts.chat, opts.msgId ?? null)
    .run();
  await launch(env, id, "analyze");
  return view(await latest(env.DB, userId));
}

/** Starts a container run: the full analysis, or only the charts of the stored result (a new DO per run). */
async function launch(env: Env, id: string, mode: "analyze" | "render") {
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  const stub = env.ANALYZE.get(env.ANALYZE.idFromName(mode === "analyze" ? id : `${id}:render:${Date.now()}`));
  await stub.run(id, { MODE: mode, API_URL: `${base}/analysis/${id}`, TOKEN: await sign(env, `analysis|${id}`) });
}

/** The result JSON of the latest finished analysis. */
export async function analysisResult(env: Env, userId: number) {
  const a = await latest(env.DB, userId, READY);
  const obj = a && (await env.MEDIA.get(resultKey(a.id)));
  return obj ? new Response(obj.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }) : json(null, 404);
}

/** A failed redraw keeps the finished result (with the new names, but the old charts). */
export async function failAnalysis(env: Env, id: string, error: string) {
  const a = await env.DB.prepare(
    "UPDATE analyses SET status = CASE stage WHEN 'render' THEN 'done' ELSE 'failed' END, error = ?, updated_at = unixepoch() WHERE id = ? AND status = 'running' RETURNING *",
  )
    .bind(error.slice(0, 1000), id)
    .first<Analysis>();
  if (a?.status === "failed" && a.chat) await failedReport(env, a);
  if (a?.status === "done" && a.chat) await env.JOBS.send({ type: "analysis_report", analysisId: id });
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

  if (action === "memes" && m === "GET") {
    // Ready memes: [id, kind, created_at, language, tags], ordered by rowid.
    const rows = await env.DB.prepare(
      "SELECT rowid, id, kind, created_at, language, COALESCE(tags, '') FROM memes WHERE user_id = ? AND status = 'ready' AND rowid > ? ORDER BY rowid LIMIT ?",
    )
      .bind(a.user_id, Number(url.searchParams.get("after")) || 0, PAGE)
      .raw();
    return json({ rows: rows.map((r) => r.slice(1)), next: rows.length === PAGE ? rows[rows.length - 1][0] : null });
  }
  if (action === "vectors" && m === "GET") return json(await memeVectors(env, a.user_id, url.searchParams.get("ids") ?? ""));
  if (action === "analytics" && m === "GET") {
    // The SQL stats snapshot kept in the result: the web and the bot report show the same day-old numbers.
    const user = await getUser(env.DB, a.user_id);
    if (!user) return json({ error: "no user" }, 404);
    const [analytics, stats] = await Promise.all([userAnalytics(env, user), userStats(env, user)]);
    return json({ ...analytics, stats, lang: user.lang === "ru" ? "ru" : "en" });
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
    const result = await req.json<{ clusters?: Cluster[] }>();
    if (a.llm) await labelResult(env, a, result);
    await env.MEDIA.put(resultKey(id), JSON.stringify(result), JSON_META);
    return json({ ok: true });
  }
  const body = await req.json<{ stage?: string; done?: number; total?: number; error?: string }>().catch(() => ({}) as Record<string, never>);
  if (action === "progress" && m === "POST") {
    await env.DB.prepare("UPDATE analyses SET stage = ?, done = ?, total = ?, updated_at = unixepoch() WHERE id = ?")
      .bind(body.stage ?? null, body.done ?? 0, body.total ?? 0, id)
      .run();
    return json({ ok: true });
  }
  if (action === "done" && m === "POST") {
    await env.DB.prepare("UPDATE analyses SET status = 'done', stage = 'done', updated_at = unixepoch() WHERE id = ?").bind(id).run();
    if (a.chat) await env.JOBS.send({ type: "analysis_report", analysisId: id });
    return json({ ok: true });
  }
  if (action === "fail" && m === "POST") {
    await failAnalysis(env, id, body.error ?? "unknown error");
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}
