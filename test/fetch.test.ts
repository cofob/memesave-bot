import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { fetchPage } from "../src/ingest/fetch";

afterEach(() => vi.restoreAllMocks());

/** THUMB stub: records the instance names and the /fetch requests. */
function stub(status = 200) {
  const ids: string[] = [];
  const reqs: any[] = [];
  const THUMB = {
    idFromName: (n: string) => (ids.push(n), n),
    get: () => ({ fetch: async (_: string, init: RequestInit) => (reqs.push(JSON.parse(init.body as string)), new Response("PROXIED", { status })) }),
  };
  return { ids, reqs, e: { ...env, THUMB, FETCH_PROXIES: "http://a:b@p1:3128, socks5://p2:1080" } as unknown as Env };
}

describe("fetchPage", () => {
  it("goes through a proxy when blocked", async () => {
    const { ids, reqs, e } = stub();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html" } }));
    const res = await fetchPage(e, "https://site.test/p", { headers: { Referer: "https://site.test/" } }, 7);
    expect(await res.text()).toBe("PROXIED");
    expect(ids).toEqual(["u7"]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ url: "https://site.test/p", headers: { referer: "https://site.test/" } });
    expect(["http://a:b@p1:3128", "socks5://p2:1080"]).toContain(reqs[0].proxy);
  });

  it("detects a challenge page with status 200, and a network error", async () => {
    const { ids, e } = stub();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Just a moment...", { headers: { "content-type": "text/html" } }));
    expect(await (await fetchPage(e, "https://site.test/")).text()).toBe("PROXIED");
    spy.mockRejectedValue(new Error("network"));
    expect(await (await fetchPage(e, "https://site.test/")).text()).toBe("PROXIED");
    expect(ids).toEqual(["fetch", "fetch"]);
  });

  it("tries the next proxy on a failure, max 3", async () => {
    const { reqs, e } = stub(502);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 429 }));
    expect((await fetchPage(e, "https://site.test/")).status).toBe(502);
    expect(reqs.map((r) => r.proxy).sort()).toEqual(["http://a:b@p1:3128", "socks5://p2:1080"]);
  });

  it("does not use a proxy for a normal answer", async () => {
    const { reqs, e } = stub();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<p>ok</p>", { headers: { "content-type": "text/html" } }));
    expect(await (await fetchPage(e, "https://site.test/")).text()).toBe("<p>ok</p>");
    expect(reqs).toEqual([]);
  });

  it("returns the direct result without FETCH_PROXIES", async () => {
    const { reqs, e } = stub();
    e.FETCH_PROXIES = undefined;
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 403 }));
    expect((await fetchPage(e, "https://site.test/")).status).toBe(403);
    spy.mockRejectedValue(new Error("network"));
    await expect(fetchPage(e, "https://site.test/")).rejects.toThrow("network");
    expect(reqs).toEqual([]);
  });
});
