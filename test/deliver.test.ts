import { env } from "cloudflare:test";
import { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMeme } from "../src/db";
import type { Env } from "../src/env";
import { sendMeme, toInlineResult } from "../src/search/deliver";

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
});
