import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../src/db";
import type { Env } from "../src/env";
import { scraper, ScraperError } from "../src/ingest/scraper";
import { handleAccount } from "../src/webaccount";

afterEach(() => vi.restoreAllMocks());

const c = env as unknown as Env;
const me = { id: 600, lang: "en" } as User;
const api = (method: string, path: string, body?: unknown) =>
  handleAccount(new Request("https://x/", { method, body: body ? JSON.stringify(body) : undefined }), c, me, path.split("/")).then((r) => r!.json<any>());
const row = (site: string) => c.DB.prepare("SELECT cookie, error FROM site_cookies WHERE user_id = 600 AND site = ?").bind(site).first<{ cookie: string; error: string | null }>();

/** A fake scraper: the request bodies; the listing fails with the code. */
function mockScraper(code?: string) {
  const bodies: any[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    bodies.push(JSON.parse(String(init!.body)));
    return code ? Response.json({ error: { code, status: 403 } }, { status: 502 }) : Response.json({ site: "x", source: "x", title: null, items: [] });
  });
  return bodies;
}

describe("site cookies", () => {
  it("link, status, unlink; all cookies of the site are needed", async () => {
    expect(await api("PUT", "cookies/furaffinity", { a: "A1" })).toEqual({ error: "cookies required: a, b" });
    expect(await api("PUT", "cookies/x", { a: "1" })).toEqual({ error: "site: pixiv or furaffinity" });
    expect(await api("PUT", "cookies/furaffinity", { a: " A1 ", b: "B2" })).toEqual({ ok: true });
    expect(await api("PUT", "cookies/pixiv", { PHPSESSID: "1_s" })).toEqual({ ok: true });
    expect((await row("pixiv"))!.cookie).not.toContain("1_s"); // encrypted
    expect(Object.keys(await api("GET", "cookies"))).toEqual(expect.arrayContaining(["pixiv", "furaffinity"]));
    expect(await api("DELETE", "cookies/pixiv")).toEqual({ ok: true });
    expect(await api("GET", "cookies")).toEqual({ furaffinity: { error: null, created_at: expect.any(Number) } });
  });

  it("go to the scraper for pixiv and Fur Affinity links of the user only; the login wall marks them expired", async () => {
    await api("PUT", "cookies/furaffinity", { a: "A1", b: "B2" });
    await api("PUT", "cookies/pixiv", { PHPSESSID: "1_s" });
    const bodies = mockScraper();
    await scraper.fetch(c, new URL("https://www.furaffinity.net/view/7/"), undefined, 600);
    await scraper.fetch(c, new URL("https://www.pixiv.net/artworks/1"), undefined, 600);
    await scraper.fetch(c, new URL("https://www.pixiv.net/artworks/1"), undefined, 601); // another user
    await scraper.fetch(c, new URL("https://e621.net/posts/1"), undefined, 600);
    expect(bodies.map((b) => b.cookie)).toEqual(["a=A1; b=B2", "PHPSESSID=1_s", undefined, undefined]);

    mockScraper("login");
    await expect(scraper.fetch(c, new URL("https://furaffinity.net/view/7"), undefined, 600)).rejects.toThrow(ScraperError);
    expect((await row("furaffinity"))!.error).toBe("expired");
    expect((await row("pixiv"))!.error).toBeNull();
    await api("PUT", "cookies/furaffinity", { a: "A3", b: "B4" }); // linked again
    expect((await row("furaffinity"))!.error).toBeNull();
  });
});
