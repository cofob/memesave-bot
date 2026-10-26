import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addToPost } from "../src/channels";
import type { Env } from "../src/env";
import { describeStage, docText, isTransient, parseJson, toDescription, toDescriptions, topTags, type Description } from "../src/ingest/describe";

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
      meme_context: "C", cultural_meaning: "M", tags: ["a", "b"], search_phrases: ["p1", "p2"],
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
    expect(jobs).toEqual([{ body: { type: "describe", memeId: "al_a", from: 0 }, delay: 5 }]);
    jobs.length = 0;
    await env.DB.prepare("UPDATE memes SET status = 'describing' WHERE id = 'al_b'").run();
    await env.DB.prepare("UPDATE posts SET updated_at = updated_at - 60 WHERE media_group_id = 'al1'").run();
    await describeStage(e, "al_b"); // not the first: the album request is al_a's job
    expect(jobs).toEqual([]);
  });

  it("describes the photos one by one when the album request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 500 }));
    await describeStage(e, "al_a");
    expect(jobs.map((j) => j.body)).toEqual(["al_a", "al_b"].map((memeId) => ({ type: "describe", memeId, single: true })));
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
