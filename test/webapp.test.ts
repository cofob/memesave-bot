import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { checkInitData, handleApp } from "../src/webapp";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const enc = (s: string) => new TextEncoder().encode(s);
async function hmac(key: BufferSource, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc(data)));
}

/** Builds initData the way Telegram signs it. */
async function initData(botToken: string, user: object, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "q1", user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const hash = [...(await hmac(await hmac(enc("WebAppData"), botToken), check))].map((b) => b.toString(16).padStart(2, "0")).join("");
  params.set("hash", hash);
  return params.toString();
}

const e = { ...env, PUBLIC_URL: "https://m.example" } as Env;
const user = { id: 41, first_name: "A", username: "alice" };

describe("checkInitData", () => {
  it("accepts valid data and rejects tampered or old data", async () => {
    const data = await initData(e.BOT_TOKEN, user);
    expect(await checkInitData(e.BOT_TOKEN, data)).toMatchObject({ id: 41 });
    expect(await checkInitData(e.BOT_TOKEN, data.replace("alice", "mallory"))).toBeNull();
    expect(await checkInitData("2:other", data)).toBeNull();
    expect(await checkInitData(e.BOT_TOKEN, await initData(e.BOT_TOKEN, user, 1000))).toBeNull();
  });
});

describe("app API", () => {
  it("lists only the user's memes, filters by tag, counts tags", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (41, 'user')").run();
    const add = (id: string, owner: number, tags: string) =>
      e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, tags) VALUES (?, ?, 'photo', 'f', ?, 'ready', ?, ?)")
        .bind(id, owner, id, id, tags)
        .run();
    await add("m1", 41, "cat\nsad");
    await add("m2", 41, "dog");
    await add("x1", 42, "cat");
    const auth = { Authorization: `tma ${await initData(e.BOT_TOKEN, user)}` };
    const get = async (path: string) => (await handleApp(new Request(`https://m.example${path}`, { headers: auth }), e, ctx))!;

    expect((await handleApp(new Request("https://m.example/app/api/memes"), e, ctx))!.status).toBe(403);
    const all = await (await get("/app/api/memes?sort=title")).json<any>();
    expect(all.items.map((m: any) => m.id)).toEqual(["m1", "m2"]);
    expect(all.items[0].thumb).toMatch(/^https:\/\/m\.example\/app\/thumb\/m1\?e=\d+&s=/);
    const cats = await (await get("/app/api/memes?tag=cat")).json<any>();
    expect(cats.items.map((m: any) => m.id)).toEqual(["m1"]);
    expect(await (await get("/app/api/tags")).json()).toEqual([
      { tag: "cat", count: 1 },
      { tag: "sad", count: 1 },
      { tag: "dog", count: 1 },
    ]);
    expect((await get("/app/api/memes/x1")).status).toBe(404);
    expect((await get("/app/thumb/m1?e=9999999999&s=bad")).status).toBe(404);
  });
});

describe("app search modes", () => {
  it("returns the text index and keyword (fts) results for the user only", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (43, 'user')").run();
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, ocr_text, tags) VALUES ('s1', 43, 'photo', 'f', 's1', 'ready', 'Monday cat', 'когда понедельник', 'cat')",
    ).run();
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, ocr_text) VALUES ('s2', 44, 'photo', 'f', 's2', 'ready', 'Other', 'понедельник')",
    ).run();
    const auth = { Authorization: `tma ${await initData(e.BOT_TOKEN, { id: 43, first_name: "B" })}` };
    const get = async (path: string) => (await handleApp(new Request(`https://m.example${path}`, { headers: auth }), e, ctx))!.json<any>();

    const index = await get("/app/api/index");
    expect(index.map((m: any) => [m.id, m.ocr_text, m.tags])).toEqual([["s1", "когда понедельник", ["cat"]]]);
    const fts = await get(`/app/api/search?mode=fts&q=${encodeURIComponent("понедел")}`);
    expect(fts.items.map((m: any) => m.id)).toEqual(["s1"]);
  });
});

describe("metadata filters", () => {
  it("filters the list by type, status, orientation, text, language and length; counts facets", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (45, 'user')").run();
    const add = (id: string, kind: string, status: string, w: number | null, h: number | null, ocr: string, lang: string | null, dur: number | null) =>
      e.DB.prepare(
        "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, width, height, ocr_text, language, duration) VALUES (?, 45, ?, 'f', ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, kind, id, status, w, h, ocr, lang, dur)
        .run();
    await add("wide", "photo", "ready", 1600, 900, "hello", "en", null);
    await add("tall", "photo", "failed", 720, 1280, "", null, null);
    await add("sq", "video", "describing", 500, 500, "привет", "ru", 5);
    await add("long", "animation", "ready", 400, 300, "", null, 90);
    const auth = { Authorization: `tma ${await initData(e.BOT_TOKEN, { id: 45, first_name: "F" })}` };
    const ids = async (query: string) =>
      (await (await handleApp(new Request(`https://m.example/app/api/memes?sort=title&${query}`, { headers: auth }), e, ctx))!.json<any>()).items
        .map((m: any) => m.id)
        .sort();

    expect(await ids("kind=photo")).toEqual(["tall", "wide"]);
    expect(await ids("kind=video,animation")).toEqual(["long", "sq"]);
    expect(await ids("status=processing")).toEqual(["sq"]);
    expect(await ids("orient=landscape")).toEqual(["long", "wide"]);
    expect(await ids("orient=square,portrait")).toEqual(["sq", "tall"]);
    expect(await ids("text=yes&kind=photo")).toEqual(["wide"]);
    expect(await ids("lang=ru")).toEqual(["sq"]);
    expect(await ids("dur=long")).toEqual(["long"]);
    expect(await ids("kind=nonsense")).toEqual(["long", "sq", "tall", "wide"]);

    const f = await (await handleApp(new Request("https://m.example/app/api/facets", { headers: auth }), e, ctx))!.json<any>();
    expect(f.counts).toMatchObject({ total: 4, "kind:photo": 2, "status:failed": 1, "orient:landscape": 2, "text:yes": 2, "dur:long": 1 });
    expect(f.languages).toEqual([
      { value: "en", count: 1 },
      { value: "ru", count: 1 },
    ]);
  });
});

describe("batch actions", () => {
  it("deletes and links files only for the user's own memes", async () => {
    const deleted: string[] = [];
    const be = { ...e, VECTORS: { deleteByIds: async (ids: string[]) => void deleted.push(...ids) } } as unknown as Env;
    const u = { id: 61, first_name: "B", username: "bob" };
    await be.DB.prepare("INSERT INTO users (id, role) VALUES (61, 'user')").run();
    const add = (id: string, owner: number, title: string | null, key: string) =>
      be.DB.prepare("INSERT INTO memes (id, user_id, kind, mime, file_id, file_unique_id, status, title, r2_file) VALUES (?, ?, 'photo', 'image/png', '', ?, 'ready', ?, ?)")
        .bind(id, owner, id, title, key)
        .run();
    await add("b1", 61, "Sad cat: 2", "u/61/b1.png");
    await add("b2", 61, null, "u/61/b2.png");
    await add("y1", 62, "other", "u/62/y1.png");
    for (const k of ["u/61/b1.png", "u/61/b2.png", "u/62/y1.png"]) await be.MEDIA.put(k, "PNG", { httpMetadata: { contentType: "image/png" } });
    const auth = { Authorization: `tma ${await initData(be.BOT_TOKEN, u)}` };
    const call = async (path: string, init: RequestInit = {}) => (await handleApp(new Request(`https://m.example${path}`, { ...init, headers: auth }), be, ctx))!;

    const files = await (await call("/app/api/files?ids=b1,b2,y1")).json<any[]>();
    expect(files.map((f) => [f.id, f.name])).toEqual([
      ["b1", "Sad_cat_2.png"],
      ["b2", "b2.png"],
    ]);
    const file = await handleApp(new Request(files[0].url), be, ctx);
    expect(file!.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''Sad_cat_2.png");
    expect(await file!.text()).toBe("PNG");

    const res = await call("/app/api/delete", { method: "POST", body: JSON.stringify({ ids: ["b1", "y1"] }) });
    expect(await res.json()).toEqual({ deleted: ["b1"] });
    expect(deleted).toEqual(["b1:i", "b1:t"]);
    expect((await be.DB.prepare("SELECT id FROM memes WHERE id IN ('b1', 'b2', 'y1') ORDER BY id").all()).results).toEqual([{ id: "b2" }, { id: "y1" }]);
    expect(await be.MEDIA.head("u/61/b1.png")).toBeNull();
    expect(await be.MEDIA.head("u/62/y1.png")).not.toBeNull();
  });
});
