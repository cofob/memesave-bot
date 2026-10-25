import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedQueryEmbeddings } from "../src/cache";
import type { Meme } from "../src/db";
import { memeMedia } from "../src/media";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("memeMedia", () => {
  it("back-fills a Telegram-only meme into R2 once, then reads R2", async () => {
    await env.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, preview_file_id) VALUES ('tg1', 1, 'photo', 'fid', 'u-tg1', 'pid')",
    ).run();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("getFile") ? json({ ok: true, result: { file_path: "photos/a.jpg" } }) : new Response("IMG"),
    );
    const meme = (await env.DB.prepare("SELECT * FROM memes WHERE id = 'tg1'").first<Meme>())!;
    const a = await memeMedia(env, meme, "file");
    expect(a.mime).toBe("image/jpeg");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT r2_file FROM memes WHERE id = 'tg1'").first<string>("r2_file")).toBe("memes/tg1/file");
    expect(await (await env.MEDIA.get("memes/tg1/file"))!.text()).toBe("IMG");

    const again = (await env.DB.prepare("SELECT * FROM memes WHERE id = 'tg1'").first<Meme>())!;
    expect(new TextDecoder().decode((await memeMedia(env, again, "file")).bytes)).toBe("IMG");
    expect(fetch).toHaveBeenCalledTimes(2); // no new Telegram download

    await memeMedia(env, again, "preview"); // the preview is a separate Telegram file
    expect(await env.DB.prepare("SELECT r2_preview FROM memes WHERE id = 'tg1'").first<string>("r2_preview")).toBe("memes/tg1/preview");
  });
});

describe("cachedQueryEmbeddings", () => {
  it("embeds only misses and keeps input order", async () => {
    await env.DB.prepare("INSERT INTO users (id, role) VALUES (3, 'user')").run();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const { input } = JSON.parse(String(init!.body));
      return json({ data: input.map((s: string, index: number) => ({ index, embedding: [s.length, 0.5] })), usage: { cost: 0.001 } });
    });
    const spend = { userId: 3, kind: "search_embed" };
    expect(await cachedQueryEmbeddings(env, ["ab"], spend)).toEqual([[2, 0.5]]);
    expect(await cachedQueryEmbeddings(env, ["abc", "AB "], spend)).toEqual([[3, 0.5], [2, 0.5]]);
    expect(JSON.parse(String(fetch.mock.calls[1][1]!.body)).input).toEqual(["abc"]);
    const tx = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(cost) AS s, MIN(key_source) AS src FROM transactions WHERE user_id = 3").first();
    expect(tx).toEqual({ n: 2, s: 0.002, src: "global" });
  });
});
