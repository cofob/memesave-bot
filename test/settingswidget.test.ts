import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBot } from "../src/bot";
import type { Env } from "../src/env";

const e = { ...env, PUBLIC_URL: "https://m.example", JOBS: { send: async () => {} } } as unknown as Env;
let calls: { method: string; body: any }[] = [];

beforeEach(() => {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = String(input).split("/").pop()!;
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "b", username: "memebot" } });
    return Response.json({ ok: true, result: { message_id: 7 } });
  });
});
afterEach(() => vi.restoreAllMocks());

const from = (id: number) => ({ id, is_bot: false, first_name: "U", language_code: "en" });
const tap = (user: number, data: string, chat = user) => ({ update_id: 2, widget_query: { id: "wq", from: from(user), chat: { id: chat, type: "private" }, message_id: 7, data } });
const settings = (id: number) => e.DB.prepare("SELECT search_mode, describe_tier, hide_porn, blur_porn FROM users WHERE id = ?").bind(id).first();

describe("settings widget", () => {
  it("saves each switch from a widget tap and sends the widget the saved state", async () => {
    await e.DB.prepare("INSERT INTO users (id, role, lang) VALUES (171, 'user', 'en')").run();
    const bot = createBot(e);
    await bot.init();

    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 171, type: "private" }, from: from(171), text: "/settings", entities: [{ type: "bot_command", offset: 0, length: 9 }] } } as any);
    const sent = calls.find((c) => c.method === "sendWidget")!.body;
    expect(sent).toMatchObject({ chat_id: 171, allow_queries: true, chat_data: '{"m":"advanced","t":"max","p":0,"b":1}' });

    for (const data of ["cm:fast", "ct:medium", "cp:1", "cb:0"]) await bot.handleUpdate(tap(171, data) as any);
    expect(await settings(171)).toEqual({ search_mode: "fast", describe_tier: "medium", hide_porn: 1, blur_porn: 0 });
    const edits = calls.filter((c) => c.method === "editMessageWidgetData").map((c) => c.body);
    expect(edits.at(-1)).toEqual({ chat_id: 171, message_id: 7, chat_data: '{"m":"fast","t":"medium","p":1,"b":0}' });
    expect(calls.filter((c) => c.method === "answerWidgetQuery")).toHaveLength(4); // every tap is answered

    await bot.handleUpdate(tap(171, "cp:0") as any);
    expect(await settings(171)).toMatchObject({ hide_porn: 0 });
  });

  it("ignores bad values and taps from another chat", async () => {
    await e.DB.prepare("INSERT INTO users (id, role, lang) VALUES (172, 'user', 'en')").run();
    const bot = createBot(e);
    await bot.init();
    for (const data of ["cm:slow", "ct:max; DROP TABLE users", "cx:1", "cp:2", "cb:2"]) await bot.handleUpdate(tap(172, data) as any);
    await bot.handleUpdate(tap(172, "cm:fast", 999) as any);
    expect(await settings(172)).toEqual({ search_mode: "advanced", describe_tier: "max", hide_porn: 0, blur_porn: 1 });
    expect(calls.filter((c) => c.method === "editMessageWidgetData")).toHaveLength(0);
  });
});
