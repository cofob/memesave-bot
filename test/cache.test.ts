import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedQueryEmbeddings } from "../src/cache";
import { getMedia } from "../src/media";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("getMedia", () => {
  it("downloads once, then serves from R2", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("getFile") ? json({ ok: true, result: { file_path: "photos/a.jpg" } }) : new Response("IMG"),
    );
    const a = await getMedia(env, "fid", "uid1", "application/octet-stream");
    expect(a.mime).toBe("image/jpeg");
    expect(fetch).toHaveBeenCalledTimes(2);
    const b = await getMedia(env, "fid", "uid1", "application/octet-stream");
    expect(new TextDecoder().decode(b.bytes)).toBe("IMG");
    expect(fetch).toHaveBeenCalledTimes(2);
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
