import { env } from "cloudflare:test";
import { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMeme } from "../src/db";
import type { Env } from "../src/env";
import { sendMeme, toInlineResult } from "../src/search/deliver";

afterEach(() => vi.restoreAllMocks());

const e = { ...env, PUBLIC_URL: "https://m.example" } as Env;
const sha = "d".repeat(64);

describe("stored (imported) memes", () => {
  it("uses signed URLs inline, uploads on first send, then keeps file ids and drops the R2 copy", async () => {
    await e.MEDIA.put(`r2/${sha}`, "PHOTO", { httpMetadata: { contentType: "image/png" } });
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES ('s1', 51, 'photo', '', ?, 'ready')",
    )
      .bind(`r2:${sha}`)
      .run();
    const meme = (await getMeme(e.DB, "s1"))!;

    const inline = await toInlineResult(e, meme);
    expect(inline).toMatchObject({ type: "photo", photo_url: expect.stringMatching(/^https:\/\/m\.example\/media\/r2:d+\.jpg\?e=/) });

    let uploaded = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      uploaded = init?.body instanceof FormData || String(init?.headers ?? "").includes("multipart") || init?.body != null;
      const sizes = [
        { file_id: "small", file_unique_id: "us", width: 320, height: 320 },
        { file_id: "big", file_unique_id: "ub", width: 1280, height: 1280 },
      ];
      return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 51, type: "private" }, photo: sizes } });
    });
    await sendMeme(e, new Api("1:test"), 51, meme);

    expect(uploaded).toBe(true);
    expect(await e.DB.prepare("SELECT file_id, file_unique_id, preview_file_id FROM memes WHERE id = 's1'").first()).toEqual({
      file_id: "big",
      file_unique_id: "ub",
      preview_file_id: "small",
    });
    expect(await e.MEDIA.get(`r2/${sha}`)).toBeNull();
  });
});
