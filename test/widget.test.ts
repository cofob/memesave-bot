import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { balancePage, pairPage, progressPage, statsPage } from "../src/widgetpages";
import { analysisPage } from "../src/analysiswidget";
import { exportPage } from "../src/exportwidget";
import { savePage } from "../src/savewidget";
import { settingsPage } from "../src/settingswidget";
import { startPage } from "../src/startwidget";
import { subscribePage } from "../src/subscribewidget";

// Telegram refuses widgets over 4096 bytes after zlib at the maximum level.
const packed = (html: string) => deflateSync(Buffer.from(html), { level: 9 }).length;

describe("widget pages", () => {
  for (const lang of ["en", "ru"] as const) {
    it(`fit the size limit (${lang})`, () => {
      const pages = [progressPage(lang), statsPage(lang), balancePage(lang), pairPage(), savePage(lang), settingsPage(lang)];
      pages.push(exportPage(lang), subscribePage(lang), analysisPage(lang), startPage(lang, "memesave_bot"));
      for (const html of pages) {
        expect(html).not.toContain("\0");
        expect(packed(html)).toBeLessThanOrEqual(4096);
      }
    });
  }

  it("keeps the largest stats state under 1024 bytes", () => {
    const g = Array.from({ length: 8 }, () => ["ж".repeat(20), 99999]);
    const state = JSON.stringify({ m: 999999, z: "999.9 GB", c: "$9999.9999", d: Array(30).fill(99999), g });
    expect(new TextEncoder().encode(state).length).toBeLessThanOrEqual(1024);
  });
});
