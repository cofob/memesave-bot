import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { linkJob } from "../src/ingest/link";
import { albumMemes } from "../src/channels";
import { createToken } from "../src/tokens";
import { handleApp } from "../src/webapp";

afterEach(() => vi.restoreAllMocks());

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const jobs: unknown[] = [];
const e = { ...env, PUBLIC_URL: "https://m.example", COBALT_URL: "https://cobalt.test/", JOBS: { send: async (j: unknown) => void jobs.push(j) } } as unknown as Env;

describe("API tokens", () => {
  it("authorizes the API, keeps read tokens read-only and the account closed", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (91, 'admin')").run();
    const read = (await createToken(e.DB, 91, "r", false))!.token;
    const write = (await createToken(e.DB, 91, "w", true))!.token;
    const call = async (token: string, path: string, init: RequestInit = {}) =>
      (await handleApp(new Request(`https://m.example/app/api/${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } }), e, ctx))!.status;
    const post = (url: string) => ({ method: "POST", body: JSON.stringify({ url }) });

    expect(await call(read, "memes")).toBe(200);
    expect(await call("msv_wrong", "memes")).toBe(403);
    expect(await call(read, "import", post("https://x.com/a"))).toBe(403);
    expect(await call(write, "import", post("not a link"))).toBe(400);
    expect(await call(write, "import", post("https://x.com/a"))).toBe(202);
    expect(jobs).toEqual([{ type: "link", userId: 91, url: "https://x.com/a" }]);
    expect(await call(write, "tokens", { method: "POST", body: "{}" })).toBe(404);
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE used_at IS NOT NULL").first("n")).toBe(2);
  });

  it("saves an API link import silently as one album", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (92, 'user')").run();
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === e.COBALT_URL) return Response.json({ status: "picker", picker: [{ type: "photo", url: "https://cdn/1" }, { type: "photo", url: "https://cdn/2" }] });
      if (url.startsWith("https://cdn/")) return new Response("X", { headers: { "Content-Type": "image/jpeg" } });
      sent.push(await new Response(init?.body).text());
      const photo = (n: number) => ({ message_id: n, photo: [{ file_id: `f${n}`, file_unique_id: `api${n}`, width: 1, height: 1 }] });
      return Response.json({ ok: true, result: [photo(1), photo(2)] });
    });
    await linkJob(e, 92, "https://x.com/b");
    expect(sent[0]).toMatch(/name="chat_id"\r\n\r\n92\r\n[\s\S]*name="disable_notification"\r\n\r\ntrue/);
    const { results } = await e.DB.prepare(
      "SELECT m.source, i.position, p.media_group_id FROM memes m JOIN post_items i ON i.meme_id = m.id JOIN posts p ON p.id = i.post_id WHERE m.user_id = 92 ORDER BY i.position",
    ).all<{ source: string; position: number; media_group_id: string }>();
    expect(results.map((r) => [r.source, r.position])).toEqual([["https://x.com/b", 0], ["https://x.com/b", 1]]);
    expect(results[0].media_group_id).toMatch(/^link:/);
    await linkJob(e, 92, "https://x.com/b"); // already saved: no download
    expect(sent).toHaveLength(1);
  });
});

describe("OpenAPI", () => {
  it("is public and describes the token API", async () => {
    const res = (await handleApp(new Request("https://m.example/app/api/openapi.json"), e, ctx))!;
    const doc = await res.json<any>();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://m.example/app/api");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/memes", "/memes/{id}", "/upload", "/import", "/search"]));
  });
});

describe("uploads with an album", () => {
  it("keeps the source and groups the files of one album in order", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (93, 'admin')").run();
    const token = (await createToken(e.DB, 93, "sync", true))!.token;
    const up = async (name: string, position: number, album = "tiktok:1") => {
      const form = new FormData();
      form.set("file", new File([name], `${name}.jpg`, { type: "image/jpeg" }));
      form.set("source", "https://www.tiktok.com/@u/video/1");
      form.set("saved_at", "1790000000");
      form.set("album", album);
      form.set("position", String(position));
      const res = (await handleApp(new Request("https://m.example/app/api/upload", { method: "POST", body: form, headers: { Authorization: `Bearer ${token}` } }), e, ctx))!;
      return (await res.json<{ id: string }>()).id;
    };
    const earlier = await up("a", 3, "other"); // the same file saved before in another album
    const second = await up("b", 1);
    const first = await up("a", 0);
    expect(first).toBe(earlier);
    const { results } = await e.DB.prepare(
      "SELECT m.id, m.source, m.saved_at FROM post_items i JOIN posts p ON p.id = i.post_id JOIN memes m ON m.id = i.meme_id WHERE p.media_group_id = 'api:tiktok:1' ORDER BY i.position",
    ).all<{ id: string; source: string; saved_at: number }>();
    expect(results).toEqual([
      { id: first, source: "https://www.tiktok.com/@u/video/1", saved_at: 1790000000 },
      { id: second, source: "https://www.tiktok.com/@u/video/1", saved_at: 1790000000 },
    ]);
    expect((await albumMemes(e.DB, first)).map((m) => m.id)).toEqual([first, second]); // the newest album, not both
  });
});
