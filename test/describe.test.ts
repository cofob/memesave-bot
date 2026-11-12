import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addToPost } from "../src/channels";
import type { Env } from "../src/env";
import { DESCRIBE_UNCENSORED } from "../src/config";
import { describeStage, describeModels, docText, isBlocked, isRefusal, isTransient, parseJson, toDescription, toDescriptions, topTags, type Description } from "../src/ingest/describe";

describe("parseJson", () => {
  it("parses plain, fenced and prose-wrapped JSON", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('Here it is: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => parseJson("no json")).toThrow();
  });
});

describe("toDescription", () => {
  it("unwraps arrays and single-key wrappers and fills missing fields", () => {
    expect(toDescription([{ title: "A", tags: ["X ", 1] }], "")).toMatchObject({ title: "A", tags: ["x"], ocr_text: "", language: "none" });
    expect(toDescription({ meme: { title: "B" } }, "").title).toBe("B");
  });
  it("sets porn only when the model says true", () => {
    expect(toDescription({ title: "A" }, "").porn).toBe(false);
    expect(toDescription({ title: "A", porn: "yes" }, "").porn).toBe(false);
    expect(toDescription({ title: "A", porn: true }, "").porn).toBe(true);
  });
  it("takes the title from OCR text or description when it is missing", () => {
    expect(toDescription({ ocr_text: "Line one\nline two" }, "").title).toBe("Line one");
    expect(toDescription({ description: "A cat. It is sad." }, "").title).toBe("A cat.");
  });
  it("throws with the raw output when there are no known fields", () => {
    expect(() => toDescription({ name: "C" }, '{"name":"C"}')).toThrow('Bad description JSON: {"name":"C"}');
  });
});

describe("docText", () => {
  it("joins fields and skips empty ones", () => {
    const d: Description = {
      title: "T", ocr_text: "O", speech_text: "", language: "en", description: "D",
      meme_context: "C", cultural_meaning: "M", tags: ["a", "b"], search_phrases: ["p1", "p2"], porn: false,
    };
    expect(docText(d)).toBe("T\nO\nD\nC\nM\na, b\np1\np2");
  });
});

describe("topTags", () => {
  it("counts the user's tags, most used first", async () => {
    const add = (id: string, user: number, tags: string) =>
      env.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, tags) VALUES (?, ?, 'photo', 'f', ?, ?)")
        .bind(id, user, id, tags)
        .run();
    await add("t1", 1, "cat\nsad");
    await add("t2", 1, "cat\nmonday");
    await add("t3", 2, "dog\ndog2");
    expect(await topTags(env.DB, 1, 2)).toEqual(["cat", "sad"]);
  });
});

describe("toDescriptions", () => {
  it("takes one description per album photo and checks the count", () => {
    expect(toDescriptions({ items: [{ title: "A" }, { title: "B" }] }, "", 2).map((d) => d.title)).toEqual(["A", "B"]);
    expect(toDescriptions([{ title: "A" }], "", 1)[0].title).toBe("A");
    expect(() => toDescriptions({ items: [{ title: "A" }] }, "x", 2)).toThrow("Expected 2 descriptions: x");
  });
});

describe("album describe", () => {
  const jobs: { body: any; delay?: number }[] = [];
  const e = { ...env, JOBS: { send: async (body: unknown, o?: { delaySeconds?: number }) => void jobs.push({ body, delay: o?.delaySeconds }) } } as unknown as Env;
  const add = async (id: string, status: string, position: number) => {
    await env.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES (?, 80, 'photo', 'f', ?, ?)").bind(id, id, status).run();
    await addToPost(env.DB, 80, { memeId: id, mediaGroupId: "al1", position });
  };

  it("waits for the album, then only the first pending photo describes it", async () => {
    await add("al_a", "describing", 1);
    await add("al_b", "embedding", 2);
    await describeStage(e, "al_a");
    expect(jobs).toEqual([{ body: { type: "describe", memeId: "al_a", gen: 0, from: 0 }, delay: 5 }]);
    jobs.length = 0;
    await env.DB.prepare("UPDATE memes SET status = 'describing' WHERE id = 'al_b'").run();
    await env.DB.prepare("UPDATE posts SET updated_at = updated_at - 60 WHERE media_group_id = 'al1'").run();
    await describeStage(e, "al_b"); // not the first: the album request is al_a's job
    expect(jobs).toEqual([]);
  });

  it("describes the photos one by one when the album request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 500 }));
    await describeStage(e, "al_a");
    expect(jobs.map((j) => j.body)).toEqual(["al_a", "al_b"].map((memeId) => ({ type: "describe", memeId, gen: 0, single: true })));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    jobs.length = 0;
  });
});

describe("isTransient", () => {
  it("switches the model on provider errors, not on bad requests", () => {
    expect(isTransient(new Error('OpenRouter /chat/completions 500 (global key): {"message":"Internal Server Error"}'))).toBe(true);
    expect(isTransient(new Error("OpenRouter /chat/completions 429 (user key): {}"))).toBe(true);
    expect(isTransient(new Error("OpenRouter /chat/completions 400 (user key): {}"))).toBe(false);
  });
});

describe("refusals", () => {
  const VECTORS = { upsert: async () => ({ mutationId: "m" }) };
  const e = { ...env, VECTORS, PUBLIC_URL: "https://m.example", JOBS: { send: async () => {} } } as unknown as Env;
  const calls: { model: string; content: { type: string }[] }[] = [];
  const answers: Record<string, unknown>[] = [];
  const add = async (id: string, kind: "photo" | "video", preview = false) => {
    await env.MEDIA.put(`u/90/${id}`, "DATA", { httpMetadata: { contentType: kind === "photo" ? "image/jpeg" : "video/mp4" } });
    if (preview) await env.MEDIA.put(`u/90/${id}.jpg`, "FRAME", { httpMetadata: { contentType: "image/jpeg" } });
    await env.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, r2_file, r2_preview, file_size, status) VALUES (?, 90, ?, 'f', ?, ?, ?, 100, 'describing')")
      .bind(id, kind, id, `u/90/${id}`, preview ? `u/90/${id}.jpg` : null)
      .run();
  };
  const title = (id: string) => env.DB.prepare("SELECT status, title FROM memes WHERE id = ?").bind(id).first();
  const mock = (answer: (n: number) => Record<string, unknown>) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/embeddings")) return Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { cost: 0 } });
      const body = JSON.parse(String(init!.body));
      calls.push({ model: body.model, content: body.messages[1].content });
      return Response.json({ choices: [{ message: answer(calls.length) }], usage: { cost: 0 } });
    });
  afterEach(() => {
    vi.restoreAllMocks();
    calls.length = 0;
    answers.length = 0;
  });

  it("detects refusal sentences, not memes about them", () => {
    expect(isRefusal("I'm sorry, but I can't help with that request.")).toBe(true);
    expect(isRefusal("I cannot describe this image.")).toBe(true);
    expect(isRefusal("This goes against my guidelines.")).toBe(true);
    expect(isRefusal("I can't help falling in love")).toBe(false);
    expect(isRefusal("A cat on a sofa. " + "x".repeat(400))).toBe(false);
    expect(isBlocked(new Error("refused: no"))).toBe(true);
  });

  it("goes to the next model on a prose or JSON refusal, the uncensored model is the last", async () => {
    await add("rf1", "photo");
    mock((n) =>
      n === 1 ? { content: "I'm sorry, but I can't assist with describing this image." }
        : n === 2 ? { content: JSON.stringify({ title: "Refused", description: "I cannot describe this image." }) }
        : { content: JSON.stringify({ title: "Cat" }) },
    );
    await describeStage(e, "rf1");
    const models = describeModels({ kind: "photo", r2_preview: null, preview_file_id: null }, "medium");
    expect(models.at(-1)).toBe(DESCRIBE_UNCENSORED);
    expect(calls.map((c) => c.model)).toEqual(models);
    expect(await title("rf1")).toEqual({ status: "ready", title: "Cat" });
  });

  it("treats the refusal field as a refusal", async () => {
    await add("rf2", "photo");
    mock((n) => (n === 1 ? { content: JSON.stringify({ title: "Cat" }), refusal: "no" } : { content: JSON.stringify({ title: "Dog" }) }));
    await describeStage(e, "rf2");
    expect(calls).toHaveLength(2);
    expect(await title("rf2")).toEqual({ status: "ready", title: "Dog" });
  });

  it("sends the preview frame of a video refused by all video models to the uncensored model", async () => {
    await add("rf3", "video", true);
    mock((n) => (n <= 3 ? { content: "I can't help with that." } : { content: JSON.stringify({ title: "Clip" }) }));
    await describeStage(e, "rf3");
    expect(calls.map((c) => c.model).at(-1)).toBe(DESCRIBE_UNCENSORED);
    expect(calls[0].content.map((p) => p.type)).toContain("video_url");
    expect(calls.at(-1)!.content.map((p) => p.type)).toEqual(["text", "text", "image_url"]);
    expect(await title("rf3")).toEqual({ status: "ready", title: "Clip" });
  });

  it("skips the uncensored model for a video without a preview", () => {
    expect(describeModels({ kind: "video", r2_preview: null, preview_file_id: null }, "medium")).not.toContain(DESCRIBE_UNCENSORED);
  });
});
