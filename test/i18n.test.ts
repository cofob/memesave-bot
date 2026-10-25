import { describe, expect, it } from "vitest";
import { dict, t } from "../src/i18n";

describe("i18n", () => {
  it("has the same keys in all languages", () => {
    expect(Object.keys(dict.ru).sort()).toEqual(Object.keys(dict.en).sort());
  });
  it("replaces params", () => {
    expect(t("en", "no_access", { id: 5 })).toContain("<code>5</code>");
  });
});
