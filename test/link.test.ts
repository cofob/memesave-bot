import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { cobalt, findLink } from "../src/ingest/link";

afterEach(() => vi.restoreAllMocks());

describe("links", () => {
  it("finds links", () => {
    expect(findLink("look https://vm.tiktok.com/ZMabc/ lol")).toBe("https://vm.tiktok.com/ZMabc/");
    expect(findLink("no links here")).toBeNull();
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
