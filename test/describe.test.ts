import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { docText, parseJson, toDescription, topTags, type Description } from "../src/ingest/describe";

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
