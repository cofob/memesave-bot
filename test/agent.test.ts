import { describe, expect, it } from "vitest";
import { parseIds } from "../src/search/agent";

const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
const known = new Set([a, b]);

describe("parseIds", () => {
  it("returns known ids in order without duplicates", () => {
    expect(parseIds(`- ${b}\n- \`${a}\`\n- ${c}\n1. ${b}`, known)).toEqual([b, a]);
  });
  it("returns nothing for an empty or id-less reply", () => {
    expect(parseIds("", known)).toEqual([]);
    expect(parseIds("Nothing fits.", known)).toEqual([]);
  });
});
