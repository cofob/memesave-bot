import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analysisDue, showAnalysisProgress } from "../src/analysiswidget";
import type { Env } from "../src/env";

const e = env as unknown as Env;
afterEach(() => vi.restoreAllMocks());

// What the progress report does: the widget gets the latest progress when it is due an edit.
const tick = async (id: string, a: Parameters<typeof showAnalysisProgress>[1]) => {
  const r = await analysisDue(e, id);
  if (r) await showAnalysisProgress(e, a, r);
};

describe("analysis progress widget", () => {
  it("edits at most every 5 s and always shows the latest stage from the database", async () => {
    const edits: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      edits.push(JSON.parse(String(init?.body)).chat_data);
      return Response.json({ ok: true, result: true });
    });
    const db = e.DB;
    await db.prepare("INSERT INTO analyses (id, user_id, status, stage, done, total, chat, status_msg_id) VALUES ('an1', 401, 'running', 'vectors', 30, 120, 1, 9)").run();
    const a = { user_id: 401, pair_id: null, chat: 1, llm: 0, status_msg_id: 9 };

    await tick("an1", a);
    await db.prepare("UPDATE analyses SET done = 60, widget_at = unixepoch() - 4 WHERE id = 'an1'").run();
    await tick("an1", a); // within 5 s: skipped
    expect(edits).toEqual(['{"s":"vectors","p":25,"l":0}']);

    // Later, the edit shows what the database has now, whatever report triggered it.
    await db.prepare("UPDATE analyses SET widget_at = unixepoch() - 5, stage = 'project', done = 1, total = 2 WHERE id = 'an1'").run();
    await tick("an1", a);
    expect(edits.at(-1)).toBe('{"s":"project","p":50,"l":0}');
  });

  it("does not wait on Telegram's rate limit", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 30", parameters: { retry_after: 30 } }, { status: 429 }),
    );
    await e.DB.prepare("INSERT INTO analyses (id, user_id, status, stage, done, total, chat, status_msg_id) VALUES ('an2', 402, 'running', 'vectors', 1, 2, 1, 9)").run();
    await tick("an2", { user_id: 402, pair_id: null, chat: 1, llm: 0, status_msg_id: 9 });
    expect(fetch).toHaveBeenCalledTimes(1); // one try, no 30 s wait
  });
});
