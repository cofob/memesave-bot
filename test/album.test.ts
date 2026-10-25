import { env } from "cloudflare:test";
import type { Message } from "grammy/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../src/bot";
import type { Env } from "../src/env";
import { addToPost } from "../src/channels";
import { getMeme, getUser } from "../src/db";
import { editStatus } from "../src/ingest/describe";
import { receiveMedia } from "../src/ingest/receive";
import { detail, listMemes } from "../src/webapp";

afterEach(() => vi.restoreAllMocks());

const e = { ...env, JOBS: { send: async () => {} } } as unknown as Env;
const photo = (n: number) =>
  ({ message_id: n, media_group_id: "g1", photo: [{ file_id: `f${n}`, file_unique_id: `u${n}`, width: 1, height: 1 }] }) as unknown as Message;

describe("album status message", () => {
  it("sends one status message for a media group and shows its progress", async () => {
    await e.DB.prepare("INSERT INTO users (id, role, lang) VALUES (81, 'user', 'en')").run();
    const reply = vi.fn(async () => ({ message_id: 50 }));
    const ctx = { user: { id: 81 }, lang: "en", reply, react: async () => {} } as unknown as Ctx;
    await Promise.all([1, 2, 3].map((n) => receiveMedia(ctx, e, photo(n))));
    expect(reply).toHaveBeenCalledTimes(1);
    const { results } = await e.DB.prepare("SELECT id, status_msg_id FROM memes WHERE user_id = 81").all<{ id: string; status_msg_id: number }>();
    expect(results.map((r) => r.status_msg_id)).toEqual([50, 50, 50]);

    const edits: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      edits.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, result: true });
    });
    await e.DB.prepare("UPDATE memes SET status = 'ready', title = 'A' WHERE file_unique_id = 'u1'").run();
    await editStatus(e, (await getMeme(e.DB, results[0].id))!, "ignored");
    await e.DB.prepare("UPDATE memes SET status = 'ready', title = 'B' WHERE user_id = 81 AND title IS NULL").run();
    await editStatus(e, (await getMeme(e.DB, results[1].id))!, "ignored");
    expect(edits).toEqual([expect.stringContaining("Saved, indexing… 1/3"), expect.stringContaining("Saved 3 of 3:\n• <b>A</b>\n• <b>B</b>\n• <b>B</b>")]);
  });
});

describe("albums in the app", () => {
  it("lists an album as its first meme and shows the album in the detail", async () => {
    const db = e.DB;
    await db.prepare("INSERT INTO users (id, role, lang) VALUES (82, 'user', 'en')").run();
    for (const id of ["a1", "a2", "s1"]) {
      await db.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES (?, 82, 'photo', 'f', ?, 'ready')").bind(id, id).run();
    }
    await addToPost(db, 82, { memeId: "a2", mediaGroupId: "g", position: 2 });
    await addToPost(db, 82, { memeId: "a1", mediaGroupId: "g", position: 1 });
    await addToPost(db, 82, { memeId: "s1" });
    const user = (await getUser(db, 82))!;

    const page = await listMemes(e, user, new URL("https://x/app/api/memes"));
    expect(page.items.map((m) => [m.id, m.album]).sort()).toEqual([["a1", 2], ["s1", undefined]]);
    const filtered = await listMemes(e, user, new URL("https://x/app/api/memes?kind=photo"));
    expect(filtered.items.map((m) => m.id).sort()).toEqual(["a1", "a2", "s1"]);
    expect((await detail(e, (await getMeme(db, "a2"))!)).album.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect((await detail(e, (await getMeme(db, "s1"))!)).album).toEqual([]);
  });
});
