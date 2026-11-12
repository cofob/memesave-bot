import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../src/bot";
import type { Env } from "../src/env";
import { handleInline } from "../src/search/inline";

const e = { ...env, PUBLIC_URL: "https://m.example", UPLOADS: { send: async () => {} } } as unknown as Env;

/** Inline answer (query "" = recent memes) of user 81 from a chat of `chatType`. */
async function answer(chatType: string | undefined, hidePorn = 0) {
  let out: { id: string }[] = [];
  const ctx = { user: { id: 81, hide_porn: hidePorn }, lang: "en", inlineQuery: { query: "", chat_type: chatType }, answerInlineQuery: async (r: typeof out) => void (out = r) };
  await handleInline(ctx as unknown as Ctx, e);
  return out.map((r) => r.id).sort();
}

describe("inline porn", () => {
  it("shows porn only in the chat with the bot and private chats (unless hidden)", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (81, 'user')").run();
    for (const [id, porn] of [["i_ok", 0], ["i_porn", 1]] as const)
      await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, porn) VALUES (?, 81, 'photo', ?, ?, 'ready', ?)").bind(id, id, id, porn).run();
    const all = ["i_ok", "i_porn"];
    expect(await answer("sender")).toEqual(all);
    expect(await answer("private")).toEqual(all);
    for (const chat of ["group", "supergroup", "channel", undefined]) expect(await answer(chat)).toEqual(["i_ok"]);
    expect(await answer("sender", 1)).toEqual(["i_ok"]);
  });
});
