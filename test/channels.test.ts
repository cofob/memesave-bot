import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToPost, onBotMembership, postJob, queuePosts, renderCaption } from "../src/channels";
import type { Meme } from "../src/db";
import type { Env } from "../src/env";

const jobs: any[] = [];
const e = { ...env, PUBLIC_URL: "https://m.example", JOBS: { send: async (b: unknown) => void jobs.push(b) } as unknown as Queue } as Env;

let calls: { method: string; body: any }[] = [];
let fail: Record<string, { code: number; description: string }> = {};
beforeEach(() => {
  calls = [];
  jobs.length = 0;
  fail = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = String(input).split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, body });
    const chat = String(body.chat_id ?? "");
    if (fail[chat]) return Response.json({ ok: false, error_code: fail[chat].code, description: fail[chat].description }, { status: fail[chat].code });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: "b", username: "memebot" } });
    return Response.json({ ok: true, result: method === "sendMediaGroup" ? [] : { message_id: 1 } });
  });
});
afterEach(() => vi.restoreAllMocks());

const meme = (id: string, user: number, kind: string, status: string, tags = "") =>
  e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, tags, mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, user, kind, `f_${id}`, `u_${id}`, status, `T ${id}`, tags, kind === "animation" ? "video/mp4" : null)
    .run();
const channel = (chat: number, user: number, caption = "{caption}", enabled = 1) =>
  e.DB.prepare("INSERT INTO channels (chat_id, user_id, title, caption, enabled) VALUES (?, ?, 'Chan', ?, ?)").bind(chat, user, caption, enabled).run();
const postOf = (memeId: string) => e.DB.prepare("SELECT p.* FROM posts p JOIN post_items i ON i.post_id = p.id WHERE i.meme_id = ?").bind(memeId).first<any>();
const age = (postId: string) => e.DB.prepare("UPDATE posts SET updated_at = updated_at - 60 WHERE id = ?").bind(postId).run();

describe("posts", () => {
  it("groups a media group into one post and keeps the first caption", async () => {
    await addToPost(e.DB, 70, { memeId: "g1", mediaGroupId: "mg1", caption: "hello", position: 11 });
    await addToPost(e.DB, 70, { memeId: "g2", mediaGroupId: "mg1", caption: "other", position: 12 });
    await addToPost(e.DB, 70, { memeId: "s1" });
    await addToPost(e.DB, 70, { memeId: "s2" });
    const [a, b, c, d] = await Promise.all(["g1", "g2", "s1", "s2"].map(postOf));
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ media_group_id: "mg1", caption: "hello" });
    expect(c.id).not.toBe(d.id);
  });

  it("renders caption templates", () => {
    const memes = [{ title: "Cat", tags: "funny cat\nsad", source: "Chan" }, { title: "Dog", tags: "sad\ndog" }] as Meme[];
    expect(renderCaption("{caption}\n\n\n{tags}", { caption: "hi" }, memes)).toBe("hi\n\n#funny_cat #sad #dog");
    expect(renderCaption("{title} — {source}", { caption: null }, memes)).toBe("Cat — Chan");
    expect(renderCaption("{caption}", { caption: null }, memes)).toBe("");
    expect(renderCaption("{caption}", { caption: "x".repeat(2000) }, memes)).toHaveLength(1024);
  });
});

describe("channel linking", () => {
  const update = (status: string, rights = {}) =>
    ({
      chat: { id: -1001, type: "channel", title: "Memes" },
      from: { id: 71, is_bot: false, first_name: "u" },
      date: 0,
      old_chat_member: { status: "left", user: { id: 1 } },
      new_chat_member: { status, user: { id: 1 }, ...rights },
    }) as any;

  it("links on admin with posting rights and unlinks when they are gone", async () => {
    await onBotMembership(e, update("administrator", { can_post_messages: true }));
    expect(await e.DB.prepare("SELECT user_id, title FROM channels WHERE chat_id = -1001").first()).toEqual({ user_id: 71, title: "Memes" });
    expect(calls.at(-1)).toMatchObject({ method: "sendMessage", body: { chat_id: 71 } });
    await onBotMembership(e, update("administrator", { can_post_messages: false }));
    expect(await e.DB.prepare("SELECT 1 FROM channels WHERE chat_id = -1001").first()).toBeNull();
  });
});

describe("postJob", () => {
  it("posts an album once all memes are processed, with the caption on the first item", async () => {
    await channel(-1002, 72, "{caption}\n{tags}");
    await meme("a1", 72, "photo", "ready", "cat");
    await meme("a2", 72, "video", "describing");
    await meme("a3", 72, "animation", "ready");
    for (const [id, pos] of [["a2", 2], ["a1", 1], ["a3", 3]] as const) await addToPost(e.DB, 72, { memeId: id, mediaGroupId: "mg2", caption: pos === 1 ? "look" : null, position: pos });
    const post = await postOf("a1");
    await age(post.id);

    await postJob(e, post.id);
    expect(calls).toEqual([]); // a2 is still processing
    await e.DB.prepare("UPDATE memes SET status = 'failed' WHERE id = 'a2'").run(); // failed memes are posted too
    await queuePosts(e, "a2");
    expect(jobs).toEqual([{ type: "post", postId: post.id }]);
    await postJob(e, post.id);
    expect(calls.map((c) => c.method)).toEqual(["sendMediaGroup", "sendAnimation"]);
    expect(calls[0].body.media.map((m: any) => m.media)).toEqual(["f_a1", "f_a2"]);
    expect(calls[0].body.media[0].caption).toBe("look\n#cat");
    expect(calls[0].body.media[1].caption).toBeUndefined();
    expect(calls[1].body.caption).toBeUndefined();
    expect((await postOf("a1")).status).toBe("posted");

    calls = [];
    await postJob(e, post.id);
    expect(calls).toEqual([]);
  });

  it("waits for more album items, skips without channels, turns off lost channels", async () => {
    await meme("b1", 73, "photo", "ready");
    await addToPost(e.DB, 73, { memeId: "b1", mediaGroupId: "mg3" });
    const post = await postOf("b1");
    await postJob(e, post.id);
    expect(jobs).toEqual([{ type: "post", postId: post.id }]); // the album may still grow
    await age(post.id);
    await postJob(e, post.id);
    expect((await postOf("b1")).status).toBe("skipped");

    await channel(-1003, 74);
    await channel(-1004, 74, "");
    fail["-1003"] = { code: 403, description: "Forbidden: bot is not a member of the channel chat" };
    await meme("c1", 74, "photo", "ready");
    await addToPost(e.DB, 74, { memeId: "c1", caption: "hi" });
    const single = await postOf("c1");
    await age(single.id);
    await postJob(e, single.id);
    const sends = calls.filter((c) => c.method === "sendPhoto");
    expect(sends.map((c) => [c.body.chat_id, c.body.caption])).toEqual(expect.arrayContaining([[-1003, "hi"], [-1004, undefined]]));
    expect(await e.DB.prepare("SELECT enabled FROM channels WHERE chat_id = -1003").first("enabled")).toBe(0);
    expect(calls.some((c) => c.method === "sendMessage" && c.body.chat_id === 74)).toBe(true);
    expect(await postOf("c1")).toMatchObject({ status: "posted", error: expect.stringContaining("-1003") });
  });
});
