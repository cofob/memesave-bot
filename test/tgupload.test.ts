import { env } from "cloudflare:test";
import { Api } from "grammy";
import { describe, expect, it } from "vitest";
import { updateChannel } from "../src/channels";
import type { Env } from "../src/env";
import { queueUploads, uploadJob } from "../src/search/tgupload";

const e = { ...env, STORAGE_CHAT_ID: "-1001" } as Env;
const meme = (id: string, user: number, fileId = "") =>
  e.MEDIA.put(`u/${user}/${id}`, "PHOTO").then(() =>
    e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, mime, r2_file) VALUES (?, ?, 'photo', ?, ?, 'ready', 'image/jpeg', ?)",
    ).bind(id, user, fileId, `r2:${id}`, `u/${user}/${id}`).run(),
  );
const sent = (chat: number, n: number) => ({
  ok: true as const,
  result: { message_id: 1, date: 0, chat: { id: chat, type: "channel" }, photo: [{ file_id: `f${n}`, file_unique_id: `u${n}`, width: 1, height: 1 }] },
});

/** Api that records calls (method, chat, silent flag) and answers with `reply` instead of Telegram. */
function mockApi(reply: (chat: number, n: number) => unknown) {
  const calls: { method: string; chat: unknown; silent: unknown }[] = [];
  const api = new Api("1:test");
  api.config.use(async (_prev, method, payload) => {
    const p = payload as { chat_id?: unknown; disable_notification?: unknown };
    calls.push({ method, chat: p.chat_id, silent: p.disable_notification });
    return reply(Number(p.chat_id), calls.length) as never;
  });
  return { api, calls };
}

describe("silent uploads for inline", () => {
  it("uploads memes without a file id to the system chat and keeps their file ids", async () => {
    await meme("t1", 61);
    await meme("t2", 61, "has");
    await meme("t3", 62); // another user's meme
    const { api, calls } = mockApi(sent);

    await uploadJob(e, api, { userId: 61, memeIds: ["t1", "t2", "t3"] }, 0);

    expect(calls).toEqual([{ method: "sendPhoto", chat: -1001, silent: true }]);
    expect(await e.DB.prepare("SELECT file_id FROM memes WHERE id = 't1'").first("file_id")).toBe("f1");
  });

  it("uses the user's storage channel; only one channel is storage", async () => {
    await meme("t4", 63);
    for (const chat of [-1002, -1003]) await e.DB.prepare("INSERT INTO channels (chat_id, user_id) VALUES (?, 63)").bind(chat).run();
    await updateChannel(e.DB, 63, -1002, { storage: true });
    await updateChannel(e.DB, 63, -1003, { storage: true });
    const { api, calls } = mockApi(sent);

    await uploadJob(e, api, { userId: 63, memeIds: ["t4"] }, 0);

    expect(calls.map((c) => c.chat)).toEqual([-1003]);
    expect((await e.DB.prepare("SELECT chat_id FROM channels WHERE storage = 1").all()).results).toEqual([{ chat_id: -1003 }]);
  });

  it("throws on 429 so the whole job waits", async () => {
    await meme("t5", 64);
    const { api } = mockApi(() => ({ ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } }));

    await expect(uploadJob(e, api, { userId: 64, memeIds: ["t5"] }, 0)).rejects.toMatchObject({ parameters: { retry_after: 7 } });
  });

  it("cron queues every meme that is not in Telegram, not again for 1 h, and skips photos over 10 MB", async () => {
    await meme("q1", 91);
    await meme("q2", 91);
    await meme("q3", 92);
    await meme("q4", 92, "tg");
    await meme("q5", 92);
    await e.DB.prepare("UPDATE memes SET file_size = ? WHERE id = 'q5'").bind(11 * 2 ** 20).run();
    const sent: { userId: number; memeIds: string[] }[] = [];
    const c = { ...e, UPLOADS: { send: async (j: { userId: number; memeIds: string[] }) => void sent.push(j) } } as unknown as Env;
    await queueUploads(c);
    const mine = sent.filter((j) => j.userId === 91 || j.userId === 92).map((j) => ({ ...j, memeIds: j.memeIds.sort() }));
    expect(mine.sort((a, b) => a.userId - b.userId)).toEqual([{ userId: 91, memeIds: ["q1", "q2"] }, { userId: 92, memeIds: ["q3"] }]);
    sent.length = 0;
    await queueUploads(c);
    expect(sent.filter((j) => j.userId === 91 || j.userId === 92)).toEqual([]); // queued less than 1 h ago
  });

  it("keeps the file id when the Telegram file is already another meme of the user", async () => {
    await meme("d1", 93, "fx");
    await e.DB.prepare("UPDATE memes SET file_unique_id = 'u1' WHERE id = 'd1'").run();
    await meme("d2", 93);
    const { api } = mockApi(sent); // answers with file_unique_id u1 (taken by d1)
    await uploadJob(e, api, { userId: 93, memeIds: ["d2"] }, 0);
    expect(await e.DB.prepare("SELECT file_id FROM memes WHERE id = 'd2'").first("file_id")).toBe("f1");
  });
});
