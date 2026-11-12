import { env } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { unzipSync } from "fflate";
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

  it("gates porn behind an 18+ click and keeps it away from search engines and link previews", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (73, 'user')").run();
    await e.DB.prepare(
      `INSERT INTO memes (id, user_id, kind, mime, file_id, file_unique_id, status, title, r2_file, share_id, porn)
       VALUES ('sp1', 73, 'photo', 'image/png', '', 'sp1', 'ready', 'Porn', 'u/73/sp1.png', 'psid0001', 1), ('sp2', 73, 'photo', 'image/png', '', 'sp2', 'ready', 'Safe', 'u/73/sp2.png', 'psid0002', 0)`,
    ).run();
    await e.MEDIA.put("u/73/sp1.png", PNG, { httpMetadata: { contentType: "image/png" } });
    const porn = await (await get("/s/psid0001")).text();
    expect(porn).toContain('<meta name="robots" content="noindex">');
    expect(porn).toContain('id="show"');
    expect(porn).toMatch(/<template id="media"><img src="https:\/\/m\.example\/d\/psid0001\.png"/);
    expect(porn).not.toContain("og:image");
    expect((await get("/d/psid0001.png")).headers.get("X-Robots-Tag")).toBe("noindex");
    const safe = await (await get("/s/psid0002")).text();
    expect(safe).not.toContain('id="show"');
    expect(safe).toContain("og:image");
  });

  it("a comic page has the texts and download of every page, and a .zip of all pages", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (75, 'user')").run();
    for (const [id, title] of [["cz1", "Cover"], ["cz2", "Second"]])
      await e.DB.prepare(
        `INSERT INTO memes (id, user_id, kind, mime, file_id, file_unique_id, status, title, description, tags, r2_file) VALUES (?, 75, 'photo', 'image/png', '', ?, 'ready', ?, ?, ?, ?)`,
      )
        .bind(id, id, title, `about ${title}`, `tag_${id}\nshared`, `u/75/${id}.png`)
        .run();
    await e.MEDIA.put("u/75/cz1.png", PNG, { httpMetadata: { contentType: "image/png" } });
    await e.MEDIA.put("u/75/cz2.png", PNG, { httpMetadata: { contentType: "image/png" } });
    await e.DB.prepare("INSERT INTO posts (id, user_id, media_group_id, layout) VALUES ('pz', 75, 'g:z', 'comic')").run();
    await e.DB.prepare("INSERT INTO post_items (post_id, meme_id, position) VALUES ('pz', 'cz1', 0), ('pz', 'cz2', 1)").run();
    await e.DB.prepare("UPDATE memes SET width = 640, height = 960 WHERE id = 'cz2'").run();
    const cookie = { Cookie: `session=${await createSession(e, 75)}` };
    const { page } = await (await handleApp(new Request("https://m.example/app/api/memes/cz1/link", { method: "POST", headers: cookie }), e, ctx))!.json<{ page: string }>();
    const html = await (await get(new URL(page).pathname)).text();
    expect(html).toContain("about Cover");
    expect(html).toContain("about Second"); // the texts of the second page too
    expect(html.match(/download>/g)!.length).toBe(3); // a download per page and the .zip
    expect(html).toContain(`${page}/zip`);
    expect(html.match(/#shared/g)!.length).toBe(1); // the tags of all pages, once
    expect(html).toMatch(/<img src="[^"]+" alt="[^"]*" width="640" height="960" loading="lazy" decoding="async">/); // lazy, sized pages

    const zip = await get(`${new URL(page).pathname}/zip`);
    expect(zip.headers.get("Content-Type")).toBe("application/zip");
    expect(Object.keys(unzipSync(new Uint8Array(await zip.arrayBuffer())))).toEqual(["001.png", "002.png"]);

    const detail = await (await handleApp(new Request("https://m.example/app/api/memes/cz1", { headers: cookie }), e, ctx))!.json<{ zip: string }>();
    const own = await handleApp(new Request(detail.zip), e, ctx);
    expect(Object.keys(unzipSync(new Uint8Array(await own!.arrayBuffer())))).toEqual(["001.png", "002.png"]);
    expect((await handleApp(new Request(detail.zip.replace(/s=[^&]+/, "s=bad")), e, ctx))!.status).toBe(404);
  });
});
