import { env } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { deleteMeme } from "../src/db";
import type { Env } from "../src/env";
import { createSession } from "../src/session";
import { handleShare } from "../src/share";
import { handleApp } from "../src/webapp";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const e = { ...env, PUBLIC_URL: "https://m.example" } as Env;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const get = (path: string) => handleShare(new Request(`https://m.example${path}`), e, ctx);

describe("public share links", () => {
  it("makes a meme public on the first link and serves its page, file and OG image", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (71, 'user'), (72, 'user')").run();
    await e.DB.prepare(
      `INSERT INTO memes (id, user_id, kind, mime, file_id, file_unique_id, status, title, tags, ocr_text, r2_file)
       VALUES ('sh1', 71, 'photo', 'image/png', '', 'sh1', 'ready', 'Cat <b>"x"</b>', 'cat\nsad', 'когда понедельник', 'u/71/sh1.png')`,
    ).run();
    await e.MEDIA.put("u/71/sh1.png", PNG, { httpMetadata: { contentType: "image/png" } });
    const link = async (userId: number) =>
      (await handleApp(
        new Request("https://m.example/app/api/memes/sh1/link", { method: "POST", headers: { Cookie: `session=${await createSession(e, userId)}` } }),
        e,
        ctx,
      ))!;

    expect((await link(72)).status).toBe(404);
    const first = await (await link(71)).json<{ page: string; file: string }>();
    expect(first.page).toMatch(/^https:\/\/m\.example\/s\/[\w-]{8}$/);
    expect(first.file).toBe(first.page.replace("/s/", "/d/") + ".png");
    expect(await (await link(71)).json()).toEqual(first);

    const sid = first.page.split("/").pop()!;
    const page = await get(`/s/${sid}`);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('content="Cat &lt;b&gt;&quot;x&quot;&lt;/b&gt;"');
    expect(html).toContain(`content="https://m.example/s/${sid}/og.png"`);
    expect(html).toContain("когда понедельник");
    expect(html).not.toContain("<b>");

    const file = await get(`/d/${sid}.png`);
    expect(file.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);

    const og = await get(`/s/${sid}/og.png`);
    expect(og.headers.get("Content-Type")).toBe("image/png");
    expect((await og.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    expect((await get("/s/nope")).status).toBe(404);
    expect((await get(`/s/${sid}/other`)).status).toBe(404);
    await deleteMeme({ ...e, VECTORS: { deleteByIds: async () => {} } } as unknown as Env, "sh1");
    expect((await get(`/s/${sid}`)).status).toBe(404);
    expect((await get(`/d/${sid}.png`)).status).toBe(404);
  });
});
