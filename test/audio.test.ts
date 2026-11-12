import { env } from "cloudflare:test";
import { Api } from "grammy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachAudio, audioPosts, postOf, sendClip, sendPostAudio } from "../src/audio";
import { addToPost } from "../src/channels";
import { deleteMemes, getMeme } from "../src/db";
import type { Env } from "../src/env";
import { cobalt } from "../src/ingest/link";
import { signedQuery } from "../src/media";
import { handleApp } from "../src/webapp";

afterEach(() => vi.restoreAllMocks());

const photo = async (id: string, user: number) => {
  await env.MEDIA.put(`u/${user}/${id}.jpg`, id, { httpMetadata: { contentType: "image/jpeg" } });
  await env.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, r2_file) VALUES (?, ?, 'photo', '', ?, 'ready', ?)")
    .bind(id, user, `r2:${id}`, `u/${user}/${id}.jpg`)
    .run();
  return (await getMeme(env.DB, id))!;
};
const mp3 = (s: string) => new File([s], "a.mp3", { type: "audio/mpeg" });
const keys = async (prefix: string) => (await env.MEDIA.list({ prefix })).objects.map((o) => o.key);

describe("sound of photos", () => {
  it("keeps one audio per album, shared by its photos, replaced without copies", async () => {
    const [a, b] = [await photo("au1", 61), await photo("au2", 61)];
    for (const [i, m] of [a, b].entries()) await addToPost(env.DB, 61, { memeId: m.id, mediaGroupId: "api:x", position: i });

    expect(await attachAudio(env as Env, a, mp3("ONE"))).toBeNull();
    expect(await attachAudio(env as Env, b, mp3("TWO"))).toBeNull(); // the same album: replaces
    const audio = await audioPosts(env.DB, ["au1", "au2"]);
    expect(audio.get("au1")).toEqual(audio.get("au2"));
    const files = await keys("u/61/audio/");
    expect(files).toEqual([audio.get("au1")!.audio_r2]);
    expect(await (await env.MEDIA.get(files[0]))!.text()).toBe("TWO");

    expect(await attachAudio(env as Env, a, new File(["x"], "a.txt", { type: "text/plain" }))).toMatch(/audio file/);
    expect(await attachAudio(env as Env, a, null)).toBeNull();
    expect(await keys("u/61/audio/")).toEqual([]);
  });

  it("gives an old single photo a post for its audio", async () => {
    const m = await photo("au3", 62);
    expect(await postOf(env.DB, m.id)).toBeNull();
    await attachAudio(env as Env, m, mp3("S"));
    expect((await postOf(env.DB, m.id))?.audio_mime).toBe("audio/mpeg");
  });

  it("sends the audio once from R2, then by file id", async () => {
    const m = await photo("au4", 63);
    await attachAudio(env as Env, m, mp3("S"));
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      bodies.push(init?.body);
      return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 63, type: "private" }, audio: { file_id: "A1", file_unique_id: "ua", duration: 1 } } });
    });
    await sendPostAudio(env as Env, new Api("1:test"), 63, m.id);
    await sendPostAudio(env as Env, new Api("1:test"), 63, m.id);
    expect((await postOf(env.DB, m.id))?.audio_file_id).toBe("A1");
    expect(String(bodies[1])).toContain('"audio":"A1"');
  });

  it("renders the clip in the user's container, keeps it, drops it when the album changes and the audio with the last photo", async () => {
    const [a, b] = [await photo("au5", 64), await photo("au6", 64)];
    for (const [i, m] of [a, b].entries()) await addToPost(env.DB, 64, { memeId: m.id, mediaGroupId: "api:y", position: i });
    await attachAudio(env as Env, a, mp3("S"));
    const forms: FormData[] = [];
    const THUMB = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async (_: string, init: RequestInit) => (forms.push(init.body as FormData), new Response("MP4", { headers: { "X-Width": "720", "X-Height": "1280", "X-Duration": "9" } })) }),
    };
    const e = { ...env, THUMB, VECTORS: { deleteByIds: async () => {} } } as unknown as Env;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 64, type: "private" }, video: { file_id: "V1", file_unique_id: "uv", width: 720, height: 1280, duration: 9 } } }),
    );
    expect(await sendClip(e, new Api("1:test"), 64, b.id)).toBe(true);
    expect(await sendClip(e, new Api("1:test"), 64, b.id)).toBe(true);
    expect(forms).toHaveLength(1);
    expect(forms[0].getAll("image")).toHaveLength(2);
    const post = (await postOf(env.DB, a.id))!;
    expect(post).toMatchObject({ clip_file_id: "V1", clip_r2: expect.stringMatching(/\.clip\.mp4$/) });

    const res = await handleApp(new Request(`https://m.example/app/clip/${post.id}${await signedQuery(e, `clip|${post.id}|${post.clip_r2}`, 60)}&dl=v.mp4`), e, { waitUntil: () => {} } as unknown as ExecutionContext);
    expect([await res!.text(), res!.headers.get("Content-Disposition")]).toEqual(["MP4", "attachment; filename*=UTF-8''v.mp4"]);

    await deleteMemes(e, [b.id]);
    expect(await postOf(env.DB, a.id)).toMatchObject({ clip_r2: null, clip_file_id: null, audio_r2: post.audio_r2 });
    await deleteMemes(e, [a.id]);
    expect(await keys("u/64/audio/")).toEqual([]);
  });

  it("takes the audio of a cobalt photo post", async () => {
    const e = { ...env, COBALT_URL: "https://cobalt.test/" } as Env;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === e.COBALT_URL) return Response.json({ status: "picker", audio: "https://cdn/a", picker: [{ type: "photo", url: "https://cdn/1" }] });
      return new Response("X", { headers: { "Content-Type": url === "https://cdn/a" ? "audio/mpeg" : "image/jpeg" } });
    });
    expect((await cobalt(e, "https://www.tiktok.com/@u/photo/1")).audio?.mime).toBe("audio/mpeg");
  });
});
