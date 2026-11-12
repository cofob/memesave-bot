import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analysisStatus, failAnalysis, handleAnalysis, imageKey, resultKey, startAnalysis } from "../src/analysis";
import { md, reportMarkdown, sendReport } from "../src/analysisreport";
import { originStats, tagStats, userAnalytics } from "../src/analytics";
import { recordUse } from "../src/db";
import type { Env } from "../src/env";
import { sign } from "../src/media";

afterEach(() => vi.restoreAllMocks());

function setup(llmReply = '{"clusters":[{"id":0,"name":"Cats","summary":"Cats at work."}]}') {
  const started: Record<string, string>[] = [];
  const ANALYZE = { idFromName: (n: string) => n, get: () => ({ run: async (_: string, vars: Record<string, string>) => void started.push(vars) }) };
  const VECTORS = { getByIds: async (ids: string[]) => ids.map((id) => ({ id, values: new Float32Array([1, 0]) })) };
  const jobs: any[] = [];
  const JOBS = { send: async (b: unknown) => void jobs.push(b) };
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("openrouter.ai")) return Response.json({ choices: [{ message: { content: llmReply } }], usage: { cost: 0.001 } });
    return Response.json({ ok: true, result: { message_id: 7 } });
  });
  const e = { ...env, PUBLIC_URL: "https://m.example", ANALYZE, VECTORS, JOBS } as unknown as Env;
  return { e, started, jobs, calls };
}

const call = async (e: Env, id: string, path: string, init: RequestInit = {}, token?: string) =>
  handleAnalysis(new Request(`https://m.example/analysis/${id}/${path}`, { ...init, headers: { Authorization: `Bearer ${token ?? (await sign(e, `analysis|${id}`))}` } }), e);

const result = (clusters = [{ id: 0, size: 3, x: 0, y: 0, tags: ["cat"], sample: ["m1"] }]) => ({
  count: 3,
  clusters,
  duplicates: [],
  outliers: [],
  images: ["per_day"],
  analytics: {
    tags: { top: [{ tag: "cat|x", count: 3 }] },
    spend: { models: [] },
    origins: { top: [{ name: "Memes", kind: "channel", n: 2, uses: 5 }] },
    uses: { favorites: [{ id: "m1", title: "Fav", n: 5, last: 1 }], forgotten: [], ready: 3, never: 2, since: 1_790_000_000 },
    stats: { total: 3, photo: 3, video: 0, animation: 0, bytes: 10, spend: 0, spend30: 0, avg: 0 } },
});

describe("analytics", () => {
  it("counts tags, pairs and monthly trends", () => {
    const t = tagStats([
      { tags: "cat\nwork", month: "2026-10" },
      { tags: "cat\ncat", month: "2026-11" },
    ]);
    expect(t.top).toEqual([
      { tag: "cat", count: 2 },
      { tag: "work", count: 1 },
    ]);
    expect(t.perMeme).toEqual([
      { tags: 1, n: 1 },
      { tags: 2, n: 1 },
    ]);
    expect(t.cooc.matrix[0][1]).toBe(1);
    expect(t.trend.months).toEqual([
      { month: "2026-10", counts: { cat: 1, work: 1 } },
      { month: "2026-11", counts: { cat: 1 } },
    ]);
  });

  it("groups sources by kind and name, with their uses", () => {
    const o = originStats(
      [
        { id: "a", fwd: "channel", source: "Memes (https://t.me/memes/5)", month: "2026-10" },
        { id: "b", fwd: "channel", source: "Memes (https://t.me/memes/9)", month: "2026-10" },
        { id: "c", fwd: null, source: "https://www.tiktok.com/@x/video/1", month: "2026-11" },
        { id: "d", fwd: null, source: null, month: "2026-11" },
      ],
      new Map([["a", 3]]),
    );
    expect(o.kinds).toEqual([
      { kind: "channel", n: 2 },
      { kind: "link", n: 1 },
      { kind: "direct", n: 1 },
    ]);
    expect(o.top).toEqual([
      { name: "Memes", kind: "channel", n: 2, uses: 3 },
      { name: "tiktok.com", kind: "link", n: 1, uses: 0 },
    ]);
    expect(o.months[1]).toEqual({ month: "2026-11", counts: { link: 1, direct: 1 } });
  });

  it("counts uses of own memes only: favorites, forgotten and how memes were saved", async () => {
    await env.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, added_via, created_at) VALUES ('f1', 62, 'photo', 'f', 'uf1', 'ready', 'Fav', 'bot', 100), ('f2', 62, 'photo', 'f', 'uf2', 'ready', 'Old', 'web', 50), ('f3', 63, 'photo', 'f', 'uf3', 'ready', 'Other', NULL, 50)",
    ).run();
    await recordUse(env.DB, 62, "f1", "inline");
    await recordUse(env.DB, 62, "f1", "send");
    await recordUse(env.DB, 62, "f3", "send"); // someone else's meme: not counted
    const a = await userAnalytics(env as unknown as Env, { id: 62 } as any);
    expect(a.uses.favorites).toEqual([{ id: "f1", title: "Fav", n: 2, last: expect.any(Number) }]);
    expect(a.uses.forgotten.map((f) => f.id)).toEqual(["f2"]);
    expect(a.uses).toMatchObject({ ready: 2, never: 1, since: expect.any(Number) });
    expect(a.added.map((r) => r.via).sort()).toEqual(["bot", "web"]);
  });

  it("charts only the user's memes and spend", async () => {
    await env.DB.prepare("INSERT INTO users (id, role) VALUES (60, 'user')").run();
    await env.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, tags, file_size, width, height) VALUES ('x1', 60, 'photo', 'f', 'u1', 'ready', 'cat', 2000, 10, 10), ('x2', 61, 'video', 'f', 'u2', 'ready', 'dog', 1, 1, 1)",
    ).run();
    await env.DB.prepare("INSERT INTO transactions (user_id, kind, model, key_source, cost, meme_id) VALUES (60, 'describe', 'm', 'global', 0.5, 'x1')").run();
    const a = await userAnalytics(env as unknown as Env, { id: 60 } as any);
    expect(a.kinds).toEqual([{ k: "photo", n: 1 }]);
    expect(a.sizes).toEqual([{ k: "<100K", n: 1 }]);
    expect(a.aspect).toEqual([{ k: "square", n: 1 }]);
    expect(a.tags.top).toEqual([{ tag: "cat", count: 1 }]);
    expect(a.spend.models[0]).toMatchObject({ model: "m", cost: 0.5, n: 1 });
    expect(a.spend.perMeme).toEqual([{ kind: "describe", per_meme: 0.5 }]);
  });
});

describe("porn analytics", () => {
  it("counts porn memes, share, tags, heatmap and comics; null without porn", async () => {
    const ins = "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, tags, porn, source, created_at) VALUES";
    await env.DB.batch([
      env.DB.prepare(`${ins} ('pn1', 64, 'photo', 'f', 'pu1', 'ready', 'cat\nfur', 1, 'https://e621.net/posts/1', 1790000000), ('pn2', 64, 'photo', 'f', 'pu2', 'ready', 'cat', 1, NULL, 1790000000), ('pn3', 64, 'photo', 'f', 'pu3', 'ready', 'dog', 0, NULL, 1790000000), ('pn4', 65, 'photo', 'f', 'pu4', 'ready', 'dog', 0, NULL, 1790000000)`),
      env.DB.prepare("INSERT INTO posts (id, user_id, layout) VALUES ('pp1', 64, 'comic'), ('pp2', 64, 'carousel')"),
      env.DB.prepare("INSERT INTO post_items (post_id, meme_id, position) VALUES ('pp1', 'pn1', 1), ('pp1', 'pn2', 2), ('pp2', 'pn2', 1)"),
    ]);
    const a = await userAnalytics(env as unknown as Env, { id: 64 } as any);
    expect(a.porn).toMatchObject({ ready: 3, porn: 2, comics: 1 });
    expect(a.porn!.months).toEqual([{ month: "2026-09", n: 3, porn: 2 }]);
    expect(a.porn!.tags).toEqual([{ tag: "cat", count: 2 }, { tag: "fur", count: 1 }]);
    expect(a.porn!.heatmap.reduce((s, c) => s + c.n, 0)).toBe(2);
    expect(a.porn!.sources).toEqual([{ name: "e621.net", kind: "link", n: 1, uses: 0 }]);
    expect((await userAnalytics(env as unknown as Env, { id: 65 } as any)).porn).toBeNull();
  });

  it("shows the porn section in the bot report only when asked", () => {
    const porn = { ready: 10, porn: 4, comics: 2, months: [], heatmap: [], sources: [], tags: [{ tag: "cat", count: 3 }] };
    const r = { ...result(), analytics: { ...result().analytics, porn } } as any;
    const img = (name: string) => `![](tg://photo?id=${name})`;
    const on = reportMarkdown("en", r, img, true);
    expect(on).toContain("## Porn");
    expect(on).toContain("| Share of the collection | 40% |");
    expect(on).toContain("porn_heatmap");
    expect(on.indexOf("## Tags")).toBeLessThan(on.indexOf("## Porn"));
    expect(reportMarkdown("en", r, img)).not.toContain("## Porn");
    expect(reportMarkdown("en", result() as any, img, true)).not.toContain("## Porn");
  });
});

describe("embedding analysis", () => {
  it("runs once a day, keeps a running one and its options", async () => {
    const { e, started } = setup();
    const first = await startAnalysis(e, 70, { llm: false });
    expect(first?.status).toBe("running");
    expect(started[0]).toMatchObject({ MODE: "analyze", API_URL: `https://m.example/analysis/${first!.id}` });
    const again = await startAnalysis(e, 70, { llm: true, chat: true, msgId: 5 });
    expect(again?.id).toBe(first!.id);
    expect(started).toHaveLength(1);
    expect(await e.DB.prepare("SELECT llm, chat, status_msg_id FROM analyses WHERE id = ?").bind(first!.id).first()).toEqual({ llm: 1, chat: 1, status_msg_id: 5 });
  });

  it("serves the container, names clusters, stores the result and charts, then reports to the chat", async () => {
    const { e, jobs, calls } = setup();
    await e.DB.prepare("INSERT INTO users (id, role, lang) VALUES (71, 'user', 'ru')").run();
    await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, tags) VALUES ('m1', 71, 'photo', 'f', 'u71', 'ready', 'cat')").run();
    const { id } = (await startAnalysis(e, 71, { llm: true, chat: true }))!;

    expect((await call(e, id, "memes", {}, "bad")).status).toBe(403);
    expect(await (await call(e, id, "memes")).json()).toEqual({ rows: [["m1", "photo", expect.any(Number), null, "cat"]], next: null });
    const snapshot = await (await call(e, id, "analytics")).json<any>();
    expect(snapshot).toMatchObject({ lang: "ru", stats: { total: 1 }, tags: { top: [{ tag: "cat", count: 1 }] } });
    expect((await call(e, id, "image/per_day", { method: "PUT", body: "PNG" })).status).toBe(200);
    expect((await call(e, id, "image/Bad-Name", { method: "PUT", body: "PNG" })).status).toBe(404);

    expect((await call(e, id, "result", { method: "PUT", body: JSON.stringify(result()) })).status).toBe(200);
    expect(calls.some((c) => c.url.includes("openrouter.ai"))).toBe(true);
    const stored = await (await call(e, id, "result")).json<any>();
    expect(stored.clusters[0]).toMatchObject({ name: "Cats", summary: "Cats at work." });

    expect((await call(e, id, "done", { method: "POST", body: "{}" })).status).toBe(200);
    expect(jobs).toContainEqual({ type: "analysis_report", analysisId: id });
    expect((await analysisStatus(e, 71)).ready).toMatchObject({ id, labeled: true });

    await sendReport(e, id);
    const sent = calls.find((c) => c.url.endsWith("/sendRichMessage"))!;
    expect(sent).toBeDefined();
    // The chart PNG goes as a multipart upload next to the message.
    const form = await new Request("https://api.test", { method: "POST", body: sent.init!.body, headers: sent.init!.headers, duplex: "half" } as RequestInit).formData();
    const rich = JSON.parse(form.get("rich_message") as string);
    expect(rich.markdown).toContain("tg://photo?id=per_day");
    expect(rich.markdown).toContain("Cats");
    expect(rich.media).toEqual([{ id: "per_day", media: { type: "photo", media: expect.stringMatching(/^attach:\/\//) } }]);

    // Lists name the memes by title.
    const dups = { ...result(), duplicates: [["m1", "m1", 0.99]], outliers: ["m1"] };
    await e.MEDIA.put(`tmp/analysis/${id}.json`, JSON.stringify(dups));
    calls.length = 0;
    await sendReport(e, id);
    const form2 = await new Request("https://api.test", { method: "POST", body: calls.at(-1)!.init!.body, headers: calls.at(-1)!.init!.headers, duplex: "half" } as RequestInit).formData();
    const md2 = JSON.parse(form2.get("rich_message") as string).markdown as string;
    expect(md2).toContain("| — | — | 0.990 |"); // m1 has no title yet
    expect(md2).toContain("#### Необычные мемы"); // the user speaks Russian
  });

  it("redoes a fresh analysis that has no moods", async () => {
    const { e, started } = setup();
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (73, 'user')").run();
    const { id } = (await startAnalysis(e, 73, { llm: false }))!;
    await call(e, id, "result", { method: "PUT", body: JSON.stringify(result()) });
    await call(e, id, "done", { method: "POST", body: "{}" });
    const again = await startAnalysis(e, 73, { llm: false });
    expect(again).toMatchObject({ status: "running" });
    expect(again?.id).not.toBe(id);
    expect(started).toHaveLength(2);
  });

  it("adds AI names to a fresh analysis later and redraws its charts", async () => {
    const { e, started } = setup();
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (72, 'user')").run();
    const { id } = (await startAnalysis(e, 72, { llm: false }))!;
    await call(e, id, "result", { method: "PUT", body: JSON.stringify(result()) });
    await call(e, id, "done", { method: "POST", body: "{}" });
    expect((await analysisStatus(e, 72)).ready?.labeled).toBe(false);

    await e.MEDIA.put(imageKey(id, "moods"), "png"); // a result with moods
    expect((await startAnalysis(e, 72, { llm: false }))?.status).toBe("done"); // cached, nothing new
    expect(started).toHaveLength(1);

    const upgraded = await startAnalysis(e, 72, { llm: true });
    expect(upgraded).toMatchObject({ id, status: "running", stage: "render", labeled: true });
    expect(started[1]).toMatchObject({ MODE: "render" });
    expect((await (await e.MEDIA.get(resultKey(id)))!.json<any>()).clusters[0].name).toBeTruthy(); // the names are kept for the redraw
    expect((await analysisStatus(e, 72)).ready?.id).toBe(id); // the result stays readable during the redraw

    await failAnalysis(e, id, "boom"); // a failed redraw keeps the result
    expect(await e.DB.prepare("SELECT status FROM analyses WHERE id = ?").bind(id).first("status")).toBe("done");
  });
});

describe("bot report", () => {
  it("stays within the rich message limits with every chart and long cluster names", () => {
    const clusters = Array.from({ length: 40 }, (_, id) => ({ id, size: 9, x: 0, y: 0, tags: ["a", "b", "c", "d", "e"], sample: [], name: "N".repeat(60), summary: "S".repeat(300) }));
    const r = { ...result(clusters), duplicates: Array.from({ length: 200 }, () => ["m1", "m2", 0.99]), outliers: Array(50).fill("m1"), alignment: { worst: Array(30).fill(["m1", 0.1]) } };
    let images = 0;
    const text = reportMarkdown("ru", r as any, (name) => (images++, `![](tg://photo?id=${name} "caption")`));
    expect(images).toBeLessThanOrEqual(50);
    expect(text.length).toBeLessThan(32768);
  });

  it("escapes Markdown in data and skips charts that were not rendered", () => {
    expect(md("a|b*c_[x](y)")).toBe("a\\|b\\*c\\_\\[x\\]\\(y\\)");
    const used: string[] = [];
    const text = reportMarkdown("en", result() as any, (name) => (name === "per_day" ? (used.push(name), `![](tg://photo?id=${name})`) : ""));
    expect(used).toEqual(["per_day"]);
    expect(text).toContain("\\#cat\\|x");
    expect(text).toContain("| 1 | — | 3 | cat |");
    expect(text).toContain("_Clusters have no AI names");
    expect(text).toContain("| Memes | 2 | 5 |");
    expect(text.indexOf("## Sources")).toBeLessThan(text.indexOf("## Tags")); // the order of the web page
    expect(text).toContain("| Fav | 5 |");
  });
});
