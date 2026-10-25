import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelImport, finishImport, pollImports, retryFailed, startImport, submitImport } from "../src/batch";
import { presignedR2Url } from "../src/presign";
import { recoverLostKeys, rekeyStage } from "../src/rekey";
import type { Env } from "../src/env";
import { serveMedia, sign, signedMediaUrl } from "../src/media";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeEnv() {
  const sent: any[] = [];
  const JOBS = {
    send: async (body: unknown) => void sent.push(body),
    sendBatch: async (msgs: { body: unknown }[]) => void sent.push(...msgs.map((m) => m.body)),
  } as unknown as Queue;
  return { env: { ...env, PUBLIC_URL: "https://m.example", MEDIA_URL: "https://media.example", JOBS } as Env, sent };
}

const addMeme = (id: string, user: number, importId: string, status = "describing") =>
  env.DB.prepare(
    "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, import_id, mime, r2_file) VALUES (?, ?, 'photo', 'f', ?, ?, ?, 'image/jpeg', ?)",
  )
    .bind(id, user, `u_${id}`, status, importId, `u/${user}/${id}.jpg`)
    .run();

afterEach(() => vi.restoreAllMocks());

describe("signed media URLs", () => {
  it("serves only valid, unexpired signatures", async () => {
    const e = fakeEnv().env;
    await env.MEDIA.put("u/1/abc", "IMG", { httpMetadata: { contentType: "image/jpeg" } });
    await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, mime, r2_file) VALUES ('abc', 1, 'photo', '', 'r2:abc', 'image/jpeg', 'u/1/abc')").run();
    const meme = (await e.DB.prepare("SELECT * FROM memes WHERE id = 'abc'").first<any>())!;
    const url = await signedMediaUrl(e, meme, "file", 60);
    expect(url).toMatch(/^https:\/\/m\.example\/media\/abc\.file\.jpg\?e=\d+&s=/);
    expect(await signedMediaUrl(e, meme, "file", 60)).toBe(url); // stable within the day: browsers and Telegram reuse their cache
    const ok = await serveMedia(new Request(url), e, ctx);
    expect([ok.status, await ok.text(), ok.headers.get("Content-Type")]).toEqual([200, "IMG", "image/jpeg"]);
    expect(ok.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+, immutable$/);
    expect((await serveMedia(new Request(url.replace("/abc.file.jpg?", "/abd.file.jpg?")), e, ctx)).status).toBe(404);
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = `https://m.example/media/abc.file.jpg?e=${past}&s=${await sign(e, `media|abc|file|${past}`)}`;
    expect((await serveMedia(new Request(expired), e, ctx)).status).toBe(404);
  });
});

describe("batch import", () => {
  it("starts once, finishes and cancels", async () => {
    const { env: e, sent } = fakeEnv();
    expect(await startImport(e.DB, 21)).toEqual({ created: true, count: 0 });
    expect(await startImport(e.DB, 21)).toEqual({ created: false, count: 0 });
    expect(await finishImport(e, 21, 77)).toBe(true);
    expect(sent).toEqual([{ type: "batch_submit", importId: expect.any(String) }]);
    expect(await e.DB.prepare("SELECT status_msg_id FROM imports WHERE user_id = 21").first<number>("status_msg_id")).toBe(77);
    expect(await finishImport(e, 21, 78)).toBe(false);

    await startImport(e.DB, 22);
    const id = await e.DB.prepare("SELECT id FROM imports WHERE user_id = 22").first<string>("id");
    await addMeme("c1", 22, id!);
    expect(await cancelImport(e, 22)).toBe(1);
    expect(sent.at(-1)).toEqual({ type: "describe", memeId: "c1" });
  });

  it("submits without tools, then imports completed results", async () => {
    const { env: e, sent } = fakeEnv();
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (23, 'user')").run();
    await e.DB.prepare("INSERT INTO imports (id, user_id, status, status_msg_id) VALUES ('imp', 23, 'submitting', 5)").run();
    await addMeme("p1", 23, "imp");
    await addMeme("p2", 23, "imp");

    let submitted: any;
    const telegram: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("api.telegram.org")) {
        telegram.push(url.split("/").pop()!);
        return json({ ok: true, result: { message_id: 1 } });
      }
      if (init?.method === "POST") {
        submitted = JSON.parse(String(init.body));
        return json({ id: "b1", status: "validating" }, 202);
      }
      return json({
        id: "b1",
        status: "completed",
        usage: { cost: 0.01, prompt_tokens: 100, completion_tokens: 50 },
        results: [
          { custom_id: "p1", response: { status_code: 200, body: { choices: [{ message: { content: '{"title":"Cat","tags":["cat"]}' } }] } } },
          { custom_id: "p2", error: { message: "bad" } },
        ],
      });
    });

    await submitImport(e, "imp");
    expect(Object.keys(submitted).at(-1)).toBe("requests");
    expect(submitted.callback_url).toBe("https://m.example/batch/webhook");
    expect(submitted.requests).toHaveLength(2);
    expect(submitted.requests[0].body.tools).toBeUndefined();
    expect(submitted.requests[0].body.messages[1].content[1].image_url.url).toMatch(/^https:\/\/media\.example\/media\/p1\.file\.jpg\?/); // MEDIA_URL host; Vertex needs a file extension

    // Round 1: p1 succeeds, p2 fails and is resubmitted in a new batch.
    await pollImports(e);
    expect(await e.DB.prepare("SELECT status, attempts, described FROM imports WHERE id = 'imp'").first()).toEqual({
      status: "submitting",
      attempts: 1,
      described: 1,
    });
    expect(await e.DB.prepare("SELECT title, tags FROM memes WHERE id = 'p1'").first()).toEqual({ title: "Cat", tags: "cat" });
    expect(sent).toEqual([
      { type: "finish", memeId: "p1" },
      { type: "batch_submit", importId: "imp" },
    ]);

    // Rounds 2 and 3: p2 keeps failing; after the third attempt it goes to the normal pipeline.
    for (const attempt of [2, 3]) {
      await submitImport(e, "imp");
      expect(submitted.requests.map((r: any) => r.custom_id)).toEqual(["p2"]);
      await pollImports(e);
      expect(await e.DB.prepare("SELECT attempts FROM imports WHERE id = 'imp'").first<number>("attempts")).toBe(attempt);
    }
    expect(await e.DB.prepare("SELECT status, described, cost FROM imports WHERE id = 'imp'").first()).toEqual({
      status: "done",
      described: 1,
      cost: 0.03,
    });
    expect(sent.at(-1)).toEqual({ type: "describe", memeId: "p2" });
    expect(telegram.at(-1)).toBe("sendMessage");
    const tx = await e.DB.prepare("SELECT kind, cost, key_source FROM transactions WHERE user_id = 23").first();
    expect(tx).toEqual({ kind: "describe_batch", cost: 0.01, key_source: "global" });
  });
});

describe("batch failures", () => {
  it("stops a mostly failed batch instead of re-running it at full price", async () => {
    const { env: e, sent } = fakeEnv();
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (24, 'user')").run();
    await e.DB.prepare(
      "INSERT INTO imports (id, user_id, status, batch_id, key_source, attempts) VALUES ('bad', 24, 'submitted', 'b9', 'global', 3)",
    ).run();
    for (let i = 0; i < 8; i++) await addMeme(`x${i}`, 24, "bad");
    const telegram: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("api.telegram.org")) {
        telegram.push(String(input).split("/").pop()!);
        return json({ ok: true, result: { message_id: 1 } });
      }
      return json({ id: "b9", status: "failed", usage: null, results: [], error: { message: "Vertex batch image URLs require a recognized image filename extension" } });
    });

    await pollImports(e);
    expect(sent).toEqual([]); // no describe jobs: nothing goes to the full-price pipeline
    expect(await e.DB.prepare("SELECT status FROM imports WHERE id = 'bad'").first<string>("status")).toBe("failed");
    const failed = await e.DB.prepare("SELECT COUNT(*) AS n, MIN(error) AS err FROM memes WHERE import_id = 'bad' AND status = 'failed'").first<any>();
    expect(failed.n).toBe(8);
    expect(failed.err).toContain("filename extension");
    expect(telegram).toEqual(["sendMessage"]);
  });

  it("retries failed memes: photos as a new batch, videos normally", async () => {
    const { env: e, sent } = fakeEnv();
    await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES ('rp', 25, 'photo', 'f', 'u-rp', 'failed')").run();
    await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES ('rv', 25, 'video', 'f', 'u-rv', 'failed')").run();
    expect(await retryFailed(e, 25, 7)).toEqual({ photos: 1, others: 1 });
    const photo = await e.DB.prepare("SELECT status, import_id FROM memes WHERE id = 'rp'").first<any>();
    expect(photo.status).toBe("embedding");
    expect(await e.DB.prepare("SELECT status, status_msg_id FROM imports WHERE id = ?").bind(photo.import_id).first()).toEqual({
      status: "submitting",
      status_msg_id: 7,
    });
    expect(await e.DB.prepare("SELECT import_id FROM memes WHERE id = 'rv'").first<string>("import_id")).toBeNull();
    expect(sent).toEqual([
      { type: "embed", memeId: "rp" },
      { type: "embed", memeId: "rv" },
      { type: "batch_submit", importId: photo.import_id },
    ]);
  });
});

describe("retry edge cases", () => {
  it("does not batch memes that already have a description", async () => {
    const { env: e, sent } = fakeEnv();
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title) VALUES ('hd', 26, 'photo', 'f', 'u-hd', 'failed', 'Has description')",
    ).run();
    expect(await retryFailed(e, 26, null)).toEqual({ photos: 0, others: 1 });
    expect(await e.DB.prepare("SELECT status, import_id FROM memes WHERE id = 'hd'").first()).toEqual({ status: "embedding", import_id: null });
    expect(sent).toEqual([{ type: "embed", memeId: "hd" }]);
  });

  it("finishes already described memes stuck in a submitted batch", async () => {
    const { env: e, sent } = fakeEnv();
    await e.DB.prepare("INSERT INTO imports (id, user_id, status, batch_id, key_source) VALUES ('stuck', 27, 'submitted', 'b7', 'global')").run();
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, import_id) VALUES ('s1', 27, 'photo', 'f', 'u-s1', 'describing', 'Done', 'stuck')",
    ).run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ id: "b7", status: "in_progress" }));
    await pollImports(e);
    expect(sent).toEqual([{ type: "finish", memeId: "s1" }]);
    expect(await e.DB.prepare("SELECT import_id FROM memes WHERE id = 's1'").first<string>("import_id")).toBeNull();
  });
});

describe("R2 keys and presigned batch links", () => {
  it("re-keys old objects to keys with a file extension", async () => {
    const { env: e } = fakeEnv();
    await e.MEDIA.put("r2/oldsha", "OLD", { httpMetadata: { contentType: "image/png" } });
    await e.MEDIA.put("r2p/oldsha", "THUMB", { httpMetadata: { contentType: "image/jpeg" } });
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, r2_file, r2_preview) VALUES ('rk', 28, 'video', '', 'r2:oldsha', 'r2/oldsha', 'r2p/oldsha')",
    ).run();
    await rekeyStage(e, "rk");
    expect(await e.DB.prepare("SELECT r2_file, r2_preview FROM memes WHERE id = 'rk'").first()).toEqual({
      r2_file: "r2/oldsha.png",
      r2_preview: "r2p/oldsha.preview.jpg",
    });
    expect(await (await e.MEDIA.get("r2/oldsha.png"))!.text()).toBe("OLD");
    expect(await e.MEDIA.get("r2/oldsha")).toBeNull();
  });

  it("survives two re-key jobs for the same meme and relinks lost keys", async () => {
    const { env: e } = fakeEnv();
    await e.MEDIA.put("r2/racesha", "IMG", { httpMetadata: { contentType: "image/jpeg" } });
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, r2_file) VALUES ('race', 29, 'photo', '', 'r2:racesha', 'r2/racesha')",
    ).run();
    await Promise.all([rekeyStage(e, "race"), rekeyStage(e, "race")]);
    expect(await e.DB.prepare("SELECT r2_file FROM memes WHERE id = 'race'").first<string>("r2_file")).toBe("r2/racesha.jpg");

    await e.DB.prepare("UPDATE memes SET r2_file = NULL WHERE id = 'race'").run(); // as the old race left it
    expect(await recoverLostKeys(e)).toBe(1);
    expect(await e.DB.prepare("SELECT r2_file FROM memes WHERE id = 'race'").first<string>("r2_file")).toBe("r2/racesha.jpg");
  });

  it("presigns batch image links on the R2 S3 endpoint when API keys are set", async () => {
    const { env: base } = fakeEnv();
    const e = { ...base, R2_ACCESS_KEY_ID: "AKID", R2_SECRET_ACCESS_KEY: "secret" } as Env;
    const url = new URL((await presignedR2Url(e, "u/1/abc.jpg", 5 * 86400))!);
    expect(url.origin + url.pathname).toBe(`https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/memesave-media/u/1/abc.jpg`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(5 * 86400));
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(await presignedR2Url(base, "u/1/abc.jpg", 60)).toBeNull(); // without keys the Worker URL is used
  });
});

describe("blocked photos", () => {
  it("sends a photo blocked in a batch to the next model instead of resubmitting it", async () => {
    const { env: e, sent } = fakeEnv();
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (31, 'user')").run();
    await e.DB.prepare("INSERT INTO imports (id, user_id, status, batch_id, key_source) VALUES ('ib', 31, 'submitted', 'b9', 'global')").run();
    await addMeme("k1", 31, "ib");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("api.telegram.org")
        ? json({ ok: true, result: { message_id: 1 } })
        : json({ id: "b9", status: "completed", results: [{ custom_id: "k1", response: null, error: { type: "content_policy_violation_error", message: "Gemini blocked the request: SAFETY" } }] }),
    );
    await pollImports(e);
    expect(sent).toEqual([{ type: "describe", memeId: "k1", from: 1 }]);
    expect(await e.DB.prepare("SELECT import_id FROM memes WHERE id = 'k1'").first("import_id")).toBeNull();
    expect(await e.DB.prepare("SELECT status FROM imports WHERE id = 'ib'").first("status")).toBe("done");
  });

  it("describes a blocked photo with the next model", async () => {
    const { env: e } = fakeEnv();
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (32, 'user')").run();
    await env.MEDIA.put("u/32/k2.jpg", "IMG", { httpMetadata: { contentType: "image/jpeg" } });
    await addMeme("k2", 32, "");
    const models: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (!String(input).endsWith("/chat/completions")) return json({ ok: true, result: { message_id: 1 } });
      const model = JSON.parse(String(init!.body)).model;
      models.push(model);
      if (model === "google/gemini-4-argon") return json({ error: { message: "Gemini blocked the request: SAFETY" } }, 400);
      return json({ choices: [{ message: { content: '{"title":"Dog","tags":["dog"]}' } }], usage: { cost: 0.001 } });
    });
    const { describeStage } = await import("../src/ingest/describe");
    await describeStage(e, "k2").catch(() => {}); // the finish step after it is not under test
    expect(models).toEqual(["google/gemini-4-argon", "openai/gpt-6-luna"]);
    expect(await e.DB.prepare("SELECT title FROM memes WHERE id = 'k2'").first("title")).toBe("Dog");
    expect(await e.DB.prepare("SELECT model FROM transactions WHERE meme_id = 'k2'").first("model")).toBe("openai/gpt-6-luna");
  });
});
