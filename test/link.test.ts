import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { cobalt, findLink } from "../src/ingest/link";
import { thumbStage } from "../src/thumb";

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

  it("makes a missing preview in a thumb job, then starts stage 1", async () => {
    const jobs: unknown[] = [];
    const ids: string[] = [];
    const THUMB = {
      idFromName: (n: string) => (ids.push(n), n),
      get: () => ({ fetch: async () => new Response("JPEG", { headers: { "X-Width": "16", "X-Height": "9", "X-Duration": "3.4" } }) }),
    };
    const e = { ...env, THUMB, JOBS: { send: async (b: unknown) => void jobs.push(b) } } as unknown as Env;
    await e.MEDIA.put("link/t1.mp4", "VIDEO");
    await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, r2_file) VALUES ('t1', 51, 'video', 'f', 'u', 'link/t1.mp4')").run();
    await thumbStage(e, "t1");
    expect(ids).toEqual(["u51"]);
    expect(await (await e.MEDIA.get("link/t1.preview.jpg"))!.text()).toBe("JPEG");
    expect(await e.DB.prepare("SELECT r2_preview, width, height, duration FROM memes WHERE id = 't1'").first()).toEqual({
      r2_preview: "link/t1.preview.jpg",
      width: 16,
      height: 9,
      duration: 3,
    });
    expect(jobs).toEqual([{ type: "embed", memeId: "t1" }]);
  });
});
