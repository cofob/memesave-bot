import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ftsQuery, hybridSearch, rrf } from "../src/search/hybrid";

describe("rrf", () => {
  it("ranks ids found in several lists first", () => {
    expect(rrf([["a", "b", "c"], ["c", "b"], ["b"]])).toEqual(["b", "c", "a"]);
  });
});

describe("ftsQuery", () => {
  it("quotes tokens and adds prefix match", () => {
    expect(ftsQuery('Кот "в" сапогах, cat!')).toBe('"кот"* OR "сапогах"* OR "cat"*');
  });
  it("returns null for punctuation only", () => {
    expect(ftsQuery("?! - *")).toBeNull();
  });
});

describe("hybridSearch", () => {
  it("finds by keyword when vector search fails", async () => {
    await env.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, ocr_text, tags) VALUES ('m1', 1, 'photo', 'f', 'u', 'ready', 'Грустный кот', 'когда понедельник', 'cat\nкот')",
    ).run();
    const broken = { ...env, VECTORS: { query: () => Promise.reject(new Error("down")) } as unknown as Vectorize };
    const res = await hybridSearch(broken, 1, { vectors: [[0.1]], texts: ["понедельник"], limit: 10 });
    expect(res.map((m) => m.id)).toEqual(["m1"]);
    expect(await hybridSearch(broken, 2, { vectors: [], texts: ["понедельник"], limit: 10 })).toEqual([]);
  });
});
