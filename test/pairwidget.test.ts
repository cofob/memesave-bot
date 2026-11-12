import { env } from "cloudflare:test";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resultKey } from "../src/analysis";
import type { User } from "../src/db";
import type { Env } from "../src/env";
import { acceptPair, createInvite, type Pair } from "../src/pairs";
import { CARD_REV, pairQuery, sendCard, sendPairsList, sendQuiz, updateCard } from "../src/pairwidget";
import { pairPage, pairsListPage, quizPage } from "../src/widgetpages";

const e = { ...env, PUBLIC_URL: "https://m.example" } as unknown as Env;
const db = e.DB;
const bytes = (s: string) => new TextEncoder().encode(s).length;

let calls: { method: string; body: any }[] = [];
beforeEach(() => {
  calls = [];
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = String(input).split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, body });
    return Response.json({ ok: true, result: { message_id: 1, widget: { id: `w${++n}` } } });
  });
});
afterEach(() => vi.restoreAllMocks());

const user = (id: number, lang = "en") => ({ id, lang, role: "user" }) as User;
const query = (from: number, data: string) => ({ id: "q", from: { id: from, is_bot: false, first_name: "x" }, data });
const getPair = (id: string) => db.prepare("SELECT * FROM pairs WHERE id = ?").bind(id).first<Pair>() as Promise<Pair>;
async function pair(a: number, b: number) {
  await db.prepare(`INSERT INTO users (id, role) VALUES (${a}, 'user'), (${b}, 'user')`).run();
  const p = (await createInvite(db, a, `Анна${a}`, b, `Борис${b}`))!;
  return (await acceptPair(db, p.id, b, `Борис${b}`))!;
}
const meme = (user: number, id: string, fu = `u_${id}`) =>
  db
    .prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, tags, created_at) VALUES (?, ?, 'photo', 'f', ?, 'ready', ?, 'cat\ndog', unixepoch())")
    .bind(id, user, fu, `title ${id}`)
    .run();

describe("pair widgets", () => {
  it("fit Telegram's limits", () => {
    for (const html of [pairPage(), quizPage(), pairsListPage("en"), pairsListPage("ru")]) expect(deflateSync(Buffer.from(html), { level: 9 }).length).toBeLessThanOrEqual(4096);
  });

  it("answers the card tabs within 1024 bytes, the viewer's side first", async () => {
    const p = await pair(301, 302);
    expect(JSON.parse((await pairQuery(e, query(301, `pt:${p.id}:w`), user(301)))!)).toEqual({ e: 1 }); // no analysis yet
    const h = JSON.parse((await pairQuery(e, query(301, `pt:${p.id}:h`), user(301)))!);
    expect(h.a).toHaveLength(24);
    const long = "ж".repeat(300);
    const result = {
      scores: { compat: 77 },
      moods: { keys: ["k0", "k1"], emoji: ["😀", "😢"], names: { en: ["fun", "sad"] }, months: ["2026-01"], a: [[0.9, 0.1]], b: [[0.2, 0.8]], overall: [], sim: [0.5], top: [0, 1] },
      facts: { en: { title: "Twins", verdict: "", facts: [], awards: Array.from({ length: 5 }, () => ({ name: long, winner: "b", reason: long })) } },
    };
    await db.prepare("INSERT INTO analyses (id, user_id, pair_id, status) VALUES ('pa1', 301, ?, 'done')").bind(p.id).run();
    await e.MEDIA.put(resultKey("pa1"), JSON.stringify(result));
    const m = await pairQuery(e, query(302, `pt:${p.id}:m`), user(302));
    expect(JSON.parse(m!)).toEqual({ x: ["😢"], y: ["😀"], s: [50], n: ["😢 sad", "😀 fun"] });
    const w = (await pairQuery(e, query(301, `pt:${p.id}:w`), user(301)))!;
    expect(bytes(w)).toBeLessThanOrEqual(1024);
    expect(JSON.parse(w).w[0][1]).toBe("Борис302");
    expect(await pairQuery(e, query(303, `pt:${p.id}:m`), user(303))).toBeUndefined(); // not a member
  });

  it("creates a new shared card when the page changes and shows the progress", async () => {
    const p = await pair(311, 312);
    await db.prepare("UPDATE pairs SET widget_id = 'old', widget_rev = 'stale' WHERE id = ?").bind(p.id).run();
    await sendCard(e, await getPair(p.id), 311, "en");
    expect(calls.map((c) => c.method)).toEqual(["sendWidget"]);
    expect(calls[0].body).toMatchObject({ is_shared: true, allow_queries: true });
    expect(await getPair(p.id)).toMatchObject({ widget_id: "w1", widget_rev: CARD_REV });
    await sendCard(e, await getPair(p.id), 312, "ru");
    expect(calls[1]).toMatchObject({ method: "sendSharedWidget", body: { widget_id: "w1" } });
    calls = [];
    const q = await getPair(p.id);
    await updateCard(e, q, false, 40);
    await updateCard(e, q, false, 50); // too soon: skipped
    expect(calls.map((c) => [c.method, JSON.parse(c.body.public_data).pr])).toEqual([["editSharedWidgetData", 40]]);
  });

  it("plays the duel: answers checked on the server, a shared score", async () => {
    const p = await pair(321, 322);
    await meme(321, "q1");
    await meme(322, "q2");
    await meme(322, "q3", "u_q1"); // the same meme on both sides is never asked
    await sendQuiz(e, p, 321, "en");
    const asked = async () => (await db.prepare("SELECT meme_id FROM pair_quiz WHERE pair_id = ? AND user_id = 321").bind(p.id).first<string>("meme_id"))!;
    const first = JSON.parse((await pairQuery(e, query(321, `pq:${p.id}:n`), user(321)))!);
    expect(first.c).toBeUndefined();
    const id = await asked();
    expect(["q1", "q2"]).toContain(id);
    const right = id === "q1" ? "m" : "p";
    const answer = JSON.parse((await pairQuery(e, query(321, `pq:${p.id}:${right}`), user(321)))!);
    expect(answer.c).toBe(1);
    expect(answer.q.t).toMatch(/^title q[12]$/);
    const wrong = (await asked()) === "q1" ? "p" : "m";
    expect(JSON.parse((await pairQuery(e, query(321, `pq:${p.id}:${wrong}`), user(321)))!).c).toBe(0);
    const score = calls.filter((c) => c.method === "editSharedWidgetData").map((c) => JSON.parse(c.body.public_data));
    expect(score.at(-1)).toMatchObject({ sa: 1, ta: 2 });
    await db.prepare("UPDATE pairs SET b_shares = 0 WHERE id = ?").bind(p.id).run();
    expect(JSON.parse((await pairQuery(e, query(321, `pq:${p.id}:n`), user(321)))!)).toMatchObject({ e: 1 });
  });

  it("lists the pairs as a widget and sends a card on a tap", async () => {
    const p = await pair(331, 332);
    expect(await sendPairsList(e, 333, "en")).toBeNull();
    await sendPairsList(e, 331, "en");
    expect(JSON.parse(calls[0].body.chat_data)).toEqual({ p: [[p.id, "Борис332", null]] });
    await pairQuery(e, query(331, `pc:${p.id}`), user(331));
    expect(calls.at(-1)!.method).toBe("sendWidget");
  });
});
