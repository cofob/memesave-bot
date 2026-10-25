import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createSession } from "../src/session";
import { oauthCallback } from "../src/userkey";
import { handleApp } from "../src/webapp";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const jobs: any[] = [];
const JOBS = { send: async (b: unknown) => void jobs.push(b), sendBatch: async (m: { body: unknown }[]) => void jobs.push(...m.map((x) => x.body)) } as unknown as Queue;
const e = { ...env, PUBLIC_URL: "https://m.example", JOBS } as Env;
const telegram: string[] = [];

beforeEach(() => {
  jobs.length = 0;
  telegram.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("openrouter.ai/api/v1/auth/keys")) return Response.json({ key: "sk-or-web" });
    telegram.push(url.split("/").pop()!);
    return Response.json({ ok: true, result: { message_id: 9, username: "memebot" } });
  });
});
afterEach(() => vi.restoreAllMocks());

async function as(userId: number, role = "user") {
  await e.DB.prepare("INSERT OR IGNORE INTO users (id, role, username) VALUES (?, ?, ?)").bind(userId, role, `u${userId}`).run();
  const cookie = `session=${await createSession(e, userId)}`;
  return async (method: string, path: string, body?: object) => {
    const res = (await handleApp(
      new Request(`https://m.example/app/api/${path}`, {
        method,
        headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
      e,
      ctx,
    ))!;
    return { status: res.status, body: await res.json<any>() };
  };
}

describe("account API (web parity with bot commands)", () => {
  it("stats, settings and me", async () => {
    const call = await as(81);
    expect((await call("GET", "stats")).body).toMatchObject({ total: 0, spend: 0, kinds: [] });
    expect((await call("GET", "stats?all=1")).status).toBe(403);
    expect((await call("PUT", "settings", { search_mode: "fast" })).status).toBe(200);
    expect((await call("GET", "me")).body).toMatchObject({ id: 81, search_mode: "fast", key: false, role: "user" });
    expect((await call("PUT", "settings", { search_mode: "bad" })).status).toBe(400);
  });

  it("batch start, finish (status message in Telegram) and cancel", async () => {
    const call = await as(82);
    await call("POST", "batch/start");
    const overview = (await call("GET", "batch")).body;
    expect(overview.collecting).toMatchObject({ status: "collecting", photos: 0 });
    expect((await call("POST", "batch/finish")).body).toEqual({ ok: true });
    expect(telegram).toContain("sendMessage");
    expect(jobs).toContainEqual({ type: "batch_submit", importId: overview.collecting.id });
    expect((await call("POST", "batch/cancel")).body).toEqual({ count: null });
  });

  it("zip import from the app returns a signed upload link and a status", async () => {
    const call = await as(83);
    const { body } = await call("POST", "zip");
    expect(body.url).toMatch(new RegExp(`^https://m\\.example/upload/${body.id}\\?e=\\d+&s=`));
    expect((await call("GET", `zip/${body.id}`)).body).toMatchObject({ status: "uploading", imported: 0 });
  });

  it("admin endpoints are for admins only", async () => {
    const user = await as(84);
    expect((await user("GET", "admin/users")).status).toBe(403);
    const admin = await as(85, "admin");
    expect((await admin("POST", "admin/grant", { target: "@newbie_1", role: "user" })).body).toEqual({ result: "granted_pending", target: "@newbie_1" });
    expect((await admin("GET", "admin/users")).body.grants).toContainEqual({ username: "newbie_1", role: "user" });
    expect((await admin("POST", "admin/revoke", { target: "85" })).body.result).toBe("revoke_denied");
    expect((await admin("POST", "admin/revoke", { target: "84" })).body.result).toBe("revoked");
  });

  it("retries a failed meme", async () => {
    const call = await as(86);
    await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES ('f1', 86, 'photo', 'f', 'u-f1', 'failed')").run();
    expect((await call("POST", "memes/f1/retry")).status).toBe(200);
    expect(await e.DB.prepare("SELECT status FROM memes WHERE id = 'f1'").first<string>("status")).toBe("embedding");
    expect(jobs).toContainEqual({ type: "embed", memeId: "f1" });
    expect((await call("POST", "memes/f1/retry")).status).toBe(409);
  });

  it("connects OpenRouter from the web and returns to the web app", async () => {
    const call = await as(87);
    const { url } = (await call("POST", "key")).body;
    const state = new URL(url).searchParams.get("state");
    const res = await oauthCallback(new Request(`https://m.example/oauth/callback?code=c&state=${state}`), e);
    expect(res.headers.get("Location")).toBe("https://m.example/?key=connected");
    expect((await call("GET", "me")).body.key).toBe(true);
  });

  it("web photo uploads join an open batch", async () => {
    const call = await as(88);
    await call("POST", "batch/start");
    const form = new FormData();
    form.append("file", new File(["BATCHPHOTO"], "p.jpg", { type: "image/jpeg" }));
    const cookie = `session=${await createSession(e, 88)}`;
    const res = await handleApp(new Request("https://m.example/app/api/upload", { method: "POST", body: form, headers: { Cookie: cookie } }), e, ctx);
    expect(await res!.json()).toMatchObject({ duplicate: false, batched: true });
  });
});
