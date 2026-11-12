import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisStatus, handleAnalysis, startAnalysis, startPairAnalysis } from "../src/analysis";
import { DEFAULT_MOODS } from "../src/config";
import type { Env } from "../src/env";
import { sign } from "../src/media";
import { sendPairReport } from "../src/pairreport";
import { acceptPair, createInvite, endPair } from "../src/pairs";
import { handleApp } from "../src/webapp";

const started: Record<string, string>[] = [];
const jobs: any[] = [];
let calls: { url: string; body: any }[] = [];
let blocked = new Set<number>();
const e = {
  ...env,
  PUBLIC_URL: "https://m.example",
  ANALYZE: { idFromName: (n: string) => n, get: () => ({ run: async (_: string, vars: Record<string, string>) => void started.push(vars) }) },
  VECTORS: { getByIds: async (ids: string[]) => ids.map((id) => ({ id, values: new Float32Array([1, 0]) })) },
  JOBS: { send: async (b: unknown) => void jobs.push(b) },
} as unknown as Env;
const db = e.DB;

const facts = (title: string) => ({ title, verdict: "Twins.", facts: ["f1"], awards: [{ name: "Owl", winner: "b", reason: "Night memes" }] });
beforeEach(() => {
  calls = [];
  blocked = new Set();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url.endsWith("/embeddings") && body.input.length > 50) return Response.json({ error: { message: "too many inputs" } }, { status: 400 }); // as the real API
    if (url.endsWith("/embeddings")) return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: [index % 2, 1] })), usage: { cost: 0.0001 } });
    if (url.includes("openrouter.ai")) {
      const name = body.response_format.json_schema.name;
      const reply =
        name === "moods"
          ? { moods: Array.from({ length: 10 }, (_, i) => ({ key: `m${i}`, emoji: "🙂", name_en: `M${i}`, name_ru: `Н${i}`, phrases: ["a", "b", "c", "d", "e", "f"] })) }
          : name === "clusters"
            ? { clusters: [{ id: 0, name: "Cats", summary: "Cats." }] }
            : facts(body.messages[0].content.includes("Russian") ? "Ру" : "En");
      return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { cost: 0.001 } });
    }
    if (blocked.has(body.chat_id)) return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
    return Response.json({ ok: true, result: { message_id: 7, date: 0, chat: { id: body.chat_id, type: "private" } } });
  });
});
afterEach(() => vi.restoreAllMocks());

const call = async (id: string, path: string, init: RequestInit = {}) =>
  handleAnalysis(new Request(`https://m.example/analysis/${id}/${path}`, { ...init, headers: { Authorization: `Bearer ${await sign(e, `analysis|${id}`)}` } }), e);
const enc = (s: string) => new TextEncoder().encode(s);
const hmac = async (key: BufferSource, data: string) =>
  new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc(data)));
async function api(userId: number, path: string, init: RequestInit = {}) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "U" }) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  params.set("hash", [...(await hmac(await hmac(enc("WebAppData"), e.BOT_TOKEN), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const headers = { Authorization: `tma ${params}`, "Content-Type": "application/json" };
  return (await handleApp(new Request(`https://m.example/app/api/${path}`, { ...init, headers }), e, {} as ExecutionContext))!;
}
const memes = (user: number, n: number, from = 0) =>
  db.batch(
    Array.from({ length: n }, (_, i) =>
      db
        .prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, tags, language, title) VALUES (?, ?, 'photo', 'f', ?, 'ready', 'cat', 'ru', ?)")
        .bind(`p${user}_${from + i}`, user, `u${user}_${from + i}`, `T${from + i}`),
    ),
  );
async function pair(a: number, b: number, langB = "en") {
  await db.prepare(`INSERT INTO users (id, role, lang) VALUES (?, 'user', 'en'), (?, 'user', ?)`).bind(a, b, langB).run();
  const p = (await createInvite(db, a, "Ann", b, "Bob"))!;
  return (await acceptPair(db, p.id, b, "Bob"))!;
}
const result = { count: [30, 30], clusters: [{ id: 0, size: 5, tags: ["cat"], sample: ["p301_0"], share: [3, 2], type: "shared", first: 0 }], scores: { compat: 77 }, twins: [["p301_0", "p302_0", 0.99]], rhymes: [], bridge: [], influence: { clusters: [1, 0], twins: [1, 0], score: [2, 0] }, moods: null, images: [] };

describe("pair analysis", () => {
  it("API: members only, status, start and result", async () => {
    const p = await pair(501, 502);
    await memes(501, 30);
    await db.prepare("INSERT INTO users (id, role) VALUES (503, 'user')").run();
    expect((await api(503, `pairs/${p.id}/analysis`)).status).toBe(403);
    expect(await (await api(501, `pairs/${p.id}/analysis`)).json()).toEqual({ current: null, ready: null });
    const small = await api(502, `pairs/${p.id}/analysis`, { method: "POST", body: '{"llm":false}' });
    expect([small.status, await small.json()]).toEqual([400, { error: "pair_too_small" }]);
    await memes(502, 30);
    const { id } = await (await api(502, `pairs/${p.id}/analysis`, { method: "POST", body: '{"llm":false}' })).json<any>();
    expect(await db.prepare("SELECT user_id, pair_id FROM analyses WHERE id = ?").bind(id).first()).toEqual({ user_id: 502, pair_id: p.id });
    expect((await api(501, `pairs/${p.id}/analysis/result`)).status).toBe(404);
    await call(id, "result", { method: "PUT", body: JSON.stringify(result) });
    await call(id, "done", { method: "POST", body: "{}" });
    expect(await (await api(501, `pairs/${p.id}/analysis/result`)).json()).toMatchObject({ owners: [501, 502], scores: { compat: 77 } });
    expect((await api(501, "analysis/result")).status).toBe(404); // not the single analysis
  });

  it("needs 30 ready memes on each side, runs once a day, stays out of the single status", async () => {
    const p = await pair(201, 202);
    await memes(201, 30);
    await memes(202, 29);
    expect(await startPairAnalysis(e, p.id, 201, { llm: false })).toBe("pair_too_small");
    await memes(202, 1, 29);
    expect(await startPairAnalysis(e, p.id, 203, { llm: false })).toBeNull(); // not a member
    const run = await startPairAnalysis(e, p.id, 201, { llm: false });
    expect(run).toMatchObject({ status: "running" });
    expect(started.at(-1)).toMatchObject({ MODE: "pair" });
    expect((await startPairAnalysis(e, p.id, 202, { llm: true })) as any).toMatchObject({ id: (run as any).id });
    expect((await analysisStatus(e, 201)).current).toBeNull();
    expect((await analysisStatus(e, p.id)).current?.id).toBe((run as any).id);
    expect((await startAnalysis(e, 201, { llm: false }))?.id).not.toBe((run as any).id); // the single one is separate
  });

  it("serves both members to the container, adds owners, labels and facts per language, reports to both", async () => {
    const p = await pair(301, 302, "ru");
    await memes(301, 30);
    await memes(302, 30);
    await memes(303, 1);
    const { id } = (await startPairAnalysis(e, p.id, 301, { llm: true, chat: true })) as any;

    const { rows } = await (await call(id, "memes")).json<{ rows: any[][] }>();
    expect(rows).toHaveLength(60);
    expect(rows.find((r) => r[0] === "p301_0")).toEqual(["p301_0", "photo", expect.any(Number), "ru", "cat", 0]);
    expect(rows.find((r) => r[0] === "p302_0")?.[5]).toBe(1);
    const vectors = await (await call(id, "vectors?ids=p301_0,p302_0,p303_0")).json<{ id: string }[]>();
    expect(vectors.map((v) => v.id)).toEqual(["p301_0:i", "p301_0:t", "p302_0:i", "p302_0:t"]);
    expect(await (await call(id, "analytics")).json()).toMatchObject({ me: { id: 301, ready: 30 }, partner: { id: 302 }, lang: "en" });

    const moods = await (await call(id, "moods")).json<any>();
    expect(moods.moods).toHaveLength(10);
    expect(moods.moods[0]).toMatchObject({ key: "m0", name_ru: "Н0", vector: [expect.any(Number), expect.any(Number)] });
    expect(Math.hypot(...moods.moods[0].vector)).toBeCloseTo(1);
    expect(calls.filter((c) => c.url.includes("openrouter.ai"))).toHaveLength(3); // one LLM call, 60 phrases in two embedding calls
    const llm = calls.find((c) => c.body.response_format?.json_schema.name === "moods")!;
    expect(llm.body.messages[0].content).toMatch(/Russian, English|English, Russian/); // meme language ru, UI en
    calls = [];
    expect((await (await call(id, "moods")).json<any>()).moods).toEqual(moods.moods); // cached
    expect(calls).toHaveLength(0);

    await call(id, "result", { method: "PUT", body: JSON.stringify({ ...result, analytics: await (await call(id, "analytics")).json() }) });
    const stored = await (await call(id, "result")).json<any>();
    expect(stored.owners).toEqual([301, 302]);
    expect(stored.clusters[0].name).toBe("Cats");
    expect(stored.facts).toEqual({ en: facts("En"), ru: facts("Ру") });

    await call(id, "done", { method: "POST", body: "{}" });
    expect(jobs).toContainEqual({ type: "pair_report", analysisId: id });

    blocked = new Set([301]);
    await sendPairReport(e, id); // one member blocked the bot: the other still gets it
    const sent = calls.filter((c) => c.url.endsWith("/sendRichMessage"));
    expect(sent.map((c) => c.body.chat_id).sort()).toEqual([301, 302]);
    const ru = sent.find((c) => c.body.chat_id === 302)!.body;
    expect(ru.rich_message.markdown).toContain("# Ру");
    expect(ru.rich_message.markdown).toContain("Совместимость: 77%");
    expect(ru.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`https://m.example/?pair=${p.id}`);
    blocked = new Set([301, 302]);
    await expect(sendPairReport(e, id)).rejects.toThrow(); // nobody got it: the queue retries

    await endPair(db, p.id, 302);
    expect((await call(id, "memes")).status).toBe(403);
  });

  it("gives a single analysis moods of its own collection", async () => {
    await db.prepare("INSERT INTO users (id, role) VALUES (411, 'user')").run();
    const { id } = (await startAnalysis(e, 411, { llm: true }))!;
    expect((await (await call(id, "moods")).json<any>()).moods.length).toBeGreaterThan(0);
    expect(calls.find((c) => c.body.response_format?.json_schema.name === "moods")!.body.messages[0].content).toContain("one person's");
    const kinds = await db.prepare("SELECT DISTINCT kind FROM transactions WHERE user_id = 411").all<{ kind: string }>();
    expect(kinds.results.map((r) => r.kind)).toEqual(["analysis_moods"]);
  });

  it("uses the default moods without the LLM and refuses the container once the pair ends", async () => {
    const p = await pair(401, 402);
    await memes(401, 30);
    await memes(402, 30);
    const { id } = (await startPairAnalysis(e, p.id, 401, { llm: false })) as any;
    const { moods } = await (await call(id, "moods")).json<any>();
    expect(moods.map((m: any) => m.key)).toEqual(DEFAULT_MOODS.map((m) => m.key));
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["embeddings", "embeddings"]); // 72 phrases in chunks of 50
    await db.prepare("DELETE FROM pairs WHERE id = ?").bind(p.id).run(); // e.g. an account deleted
    expect((await call(id, "analytics")).status).toBe(403);
  });
});
