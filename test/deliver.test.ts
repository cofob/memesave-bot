import { env } from "cloudflare:test";
import { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMeme } from "../src/db";
import type { Env } from "../src/env";
import { addToPost } from "../src/channels";
import { sendAlbumJob, sendMeme, sendResults, toInlineResult } from "../src/search/deliver";
import { createSession } from "../src/session";
import { handleApp } from "../src/webapp";

afterEach(() => vi.restoreAllMocks());

const e = { ...env, PUBLIC_URL: "https://m.example" } as Env;
const sizes = [
  { file_id: "small", file_unique_id: "us", width: 320, height: 320 },
  { file_id: "big", file_unique_id: "ub", width: 1280, height: 1280 },
];
const photoReply = () => Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 51, type: "private" }, photo: sizes } });

describe("delivery from R2 and Telegram", () => {
  it("uses signed URLs inline, uploads on first send, keeps the file ids and the R2 copy", async () => {
    await e.MEDIA.put("u/51/s1", "PHOTO", { httpMetadata: { contentType: "image/png" } });
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, mime, r2_file) VALUES ('s1', 51, 'photo', '', 'r2:s1', 'ready', 'image/png', 'u/51/s1')",
    ).run();
    const meme = (await getMeme(e.DB, "s1"))!;

    const inline = await toInlineResult(e, meme);
    expect(inline).toMatchObject({ type: "photo", photo_url: expect.stringMatching(/^https:\/\/m\.example\/media\/s1\.file\.png\?e=/) });

    let uploaded = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      uploaded = init?.body != null && !String(init.body).startsWith("{");
      return photoReply();
    });
    await sendMeme(e, new Api("1:test"), 51, meme);

    expect(uploaded).toBe(true);
    expect(await e.DB.prepare("SELECT file_id, file_unique_id, preview_file_id, r2_file FROM memes WHERE id = 's1'").first()).toEqual({
      file_id: "big",
      file_unique_id: "ub",
      preview_file_id: "small",
      r2_file: "u/51/s1",
    });
    expect(await (await e.MEDIA.get("u/51/s1"))!.text()).toBe("PHOTO"); // permanent copy stays
  });

  it("sends by file_id first and uploads from R2 when Telegram rejects it", async () => {
    await e.MEDIA.put("memes/s2/file", "PHOTO2", { httpMetadata: { contentType: "image/jpeg" } });
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, r2_file) VALUES ('s2', 52, 'photo', 'stale', 'u-s2', 'ready', 'memes/s2/file')",
    ).run();
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const json = typeof init?.body === "string";
      bodies.push(json ? "file_id" : "upload");
      return json ? Response.json({ ok: false, error_code: 400, description: "Bad Request: wrong file identifier" }, { status: 400 }) : photoReply();
    });
    await sendMeme(e, new Api("1:test"), 52, (await getMeme(e.DB, "s2"))!);
    expect(bodies).toEqual(["file_id", "upload"]);
    expect(await e.DB.prepare("SELECT file_id FROM memes WHERE id = 's2'").first<string>("file_id")).toBe("big");
  });

  it("puts a spoiler on porn for a user who blurs it", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (153, 'user'), (154, 'user')").run();
    await e.DB.prepare("UPDATE users SET blur_porn = 0 WHERE id = 154").run();
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, porn) VALUES ('s3', 153, 'photo', 'f3', 'u-s3', 'ready', 1), ('s4', 153, 'photo', 'f4', 'u-s4', 'ready', 0)",
    ).run();
    const bodies: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => (bodies.push(JSON.parse(String(init!.body))), photoReply()));
    const api = new Api("1:test");
    await sendMeme(e, api, 153, (await getMeme(e.DB, "s3"))!);
    await sendMeme(e, api, 153, (await getMeme(e.DB, "s4"))!);
    await sendMeme(e, api, 154, (await getMeme(e.DB, "s3"))!);
    await sendMeme(e, api, -100, (await getMeme(e.DB, "s3"))!); // a channel
    expect(bodies.map((b) => !!b.has_spoiler)).toEqual([true, false, false, false]);
  });
});

describe("big album", () => {
  const jobs: { body: any; delay?: number }[] = [];
  const c = { ...e, JOBS: { send: async (body: unknown, o?: { delaySeconds?: number }) => void jobs.push({ body, delay: o?.delaySeconds }) } } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it("queues 10 photos per job with a delay and waits out a 429", async () => {
    await c.DB.prepare("INSERT INTO users (id, role) VALUES (53, 'user')").run();
    for (let i = 1; i <= 25; i++) {
      await c.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES (?, 53, 'photo', ?, ?, 'ready')").bind(`b${i}`, `f${i}`, `u${i}`).run();
      await addToPost(c.DB, 53, { memeId: `b${i}`, mediaGroupId: "bg", position: i });
    }
    const cookie = `session=${await createSession(c, 53)}`;
    const sent: string[][] = [];
    let flood = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      if (flood) return Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } }, { status: 429 });
      sent.push(JSON.parse(String(init!.body)).media.map((m: { media: string }) => m.media));
      return Response.json({ ok: true, result: [] });
    });

    const res = await handleApp(new Request("https://m.example/app/api/memes/b1/send_album", { method: "POST", headers: { Cookie: cookie } }), c, ctx);
    expect(await res!.json()).toEqual({ ok: true, queued: true });
    expect(sent).toEqual([]); // nothing sent in the request
    expect(jobs).toEqual([{ body: { type: "send_album", userId: 53, memeId: "b1", from: 0 }, delay: undefined }]);
    jobs.length = 0;

    flood = true; // Telegram asks to wait: the same part comes back later
    await sendAlbumJob(c, 53, "b1", 10);
    expect(jobs.pop()).toEqual({ body: { type: "send_album", userId: 53, memeId: "b1", from: 10 }, delay: 8 });
    flood = false;

    for (let from = 0; from < 25; ) {
      await sendAlbumJob(c, 53, "b1", from);
      from += 10;
      const next = jobs.pop();
      expect(next).toEqual(from < 25 ? { body: { type: "send_album", userId: 53, memeId: "b1", from }, delay: 30 } : undefined);
    }
    expect(sent.map((g) => [g.length, g[0]])).toEqual([[10, "f1"], [10, "f11"], [5, "f21"]]);
  });
});

describe("chat search results", () => {
  it("add buttons that open the found albums and comics in the app, one per album", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (54, 'user')").run();
    for (const id of ["sr1", "sr2", "sr3"]) {
      await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title) VALUES (?, 54, 'photo', ?, ?, 'ready', 'Comic')").bind(id, `f${id}`, `u${id}`).run();
    }
    await addToPost(e.DB, 54, { memeId: "sr1", mediaGroupId: "cm", position: 0, layout: "comic" });
    await addToPost(e.DB, 54, { memeId: "sr2", mediaGroupId: "cm", position: 1, layout: "comic" });
    const calls: { method: string; body: any }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(String(init!.body)) });
      return Response.json({ ok: true, result: [] });
    });
    const memes = await Promise.all(["sr2", "sr1", "sr3"].map(async (id) => (await getMeme(e.DB, id))!));
    await sendResults(e, new Api("T"), 54, 9, memes, "ru");
    const links = calls.find((c) => c.method === "sendMessage")!.body;
    expect(links.reply_markup.inline_keyboard).toEqual([[{ text: "📖 Comic · 2 стр.", web_app: { url: "https://m.example/?meme=sr2" } }]]);
  });
});
