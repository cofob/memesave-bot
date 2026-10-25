import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { cobalt, fetchTiktok, findLink, resolvePostId } from "../src/ingest/link";

afterEach(() => vi.restoreAllMocks());

const page = (item: object) =>
  new Response(
    `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
      __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: item } } },
    })}</script></html>`,
    { headers: { "Set-Cookie": "tt_chain_token=abc; Path=/; HttpOnly" } },
  );

describe("tiktok", () => {
  it("finds links and post ids", async () => {
    expect(findLink("look https://vm.tiktok.com/ZMabc/ lol")).toBe("https://vm.tiktok.com/ZMabc/");
    expect(findLink("no links here")).toBeNull();
    expect(await resolvePostId("https://www.tiktok.com/@u/photo/123?x=1")).toBe("123");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 301, headers: { Location: "https://www.tiktok.com/@u/video/456?a" } }));
    expect(await resolvePostId("https://vm.tiktok.com/ZMabc/")).toBe("456");
  });

  it("downloads a video with the page cookie", async () => {
    const cookies: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("/@i/video/7")) return page({ author: { uniqueId: "bob" }, video: { playAddr: "https://cdn/v.mp4" } });
      cookies.push(new Headers(init?.headers).get("Cookie"));
      return new Response("VIDEO", { headers: { "Content-Type": "video/mp4" } });
    });
    const tt = await fetchTiktok("7");
    expect(tt.source).toBe("https://www.tiktok.com/@bob/video/7");
    expect(tt.items.map((i) => [i.kind, new TextDecoder().decode(i.bytes)])).toEqual([["video", "VIDEO"]]);
    expect(cookies).toEqual(["tt_chain_token=abc"]);
  });

  it("downloads slideshow photos in order", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/@i/video/8")) {
        const img = (n: number) => ({ imageURL: { urlList: [`https://cdn/${n}.webp?`, `https://cdn/${n}.jpeg?x`] } });
        return page({ author: { uniqueId: "bob" }, imagePost: { images: [img(1), img(2)] } });
      }
      return new Response(url.split("/").pop());
    });
    const tt = await fetchTiktok("8");
    expect(tt.items.map((i) => [i.kind, new TextDecoder().decode(i.bytes)])).toEqual([["photo", "1.jpeg?x"], ["photo", "2.jpeg?x"]]);
  });

  it("downloads through cobalt: a single file and a picker", async () => {
    const e = { ...env, COBALT_URL: "https://cobalt.test/" } as Env;
    const reply = (body: object) =>
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => (String(input) === e.COBALT_URL ? Response.json(body) : new Response("X")));
    reply({ status: "tunnel", url: "https://cobalt.test/tunnel", filename: "a.gif" });
    expect((await cobalt(e, "https://x.com/a/status/1")).items.map((i) => i.kind)).toEqual(["animation"]);
    reply({ status: "picker", picker: [{ type: "photo", url: "https://cdn/1" }, { type: "video", url: "https://cdn/2" }] });
    expect((await cobalt(e, "https://instagram.com/p/x")).items.map((i) => i.kind)).toEqual(["photo", "video"]);
    reply({ status: "tunnel", url: "https://cobalt.test/tunnel", filename: "a.mp3" });
    await expect(cobalt(e, "https://soundcloud.com/x")).rejects.toThrow("not a photo or video");
  });
});
