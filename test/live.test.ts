import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { push } from "../src/live";
import { signedQuery } from "../src/media";
import { handleApp } from "../src/webapp";

const e = { ...env, PUBLIC_URL: "https://m.example" } as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const get = async (path: string, headers: HeadersInit = {}) => (await handleApp(new Request(`https://m.example${path}`, { headers }), e, ctx))!;

const enc = (s: string) => new TextEncoder().encode(s);
async function hmac(key: BufferSource, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc(data)));
}
/** Builds Mini App initData the way Telegram signs it. */
async function initData(botToken: string, user: object) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  params.set("hash", [...(await hmac(await hmac(enc("WebAppData"), botToken), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return params.toString();
}

/** Opens the push WebSocket of the user and returns it with a reader of the next message. */
async function open(id: number) {
  const res = await get(`/app/live/${id}${await signedQuery(e, `live|${id}`, 60)}`, { Upgrade: "websocket" });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const next = () => new Promise<string>((ok) => ws.addEventListener("message", (m) => ok(m.data as string), { once: true }));
  return { ws, next };
}

describe("live push", () => {
  it("gives a ticket to the own WebSocket only", async () => {
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (701, 'user')").run();
    const auth = { Authorization: `tma ${await initData(e.BOT_TOKEN, { id: 701, first_name: "A" })}` };
    const { url } = await (await get("/app/api/live", auth)).json<{ url: string }>();
    expect(url).toMatch(/^\/app\/live\/701\?e=\d+&s=/);
    expect((await get(url.replace("/701?", "/702?"), { Upgrade: "websocket" })).status).toBe(403); // the ticket of another user
    expect((await get(url)).status).toBe(426); // not a WebSocket
  });

  it("sends events to all tabs of the user, answers pings", async () => {
    const [a, b] = [await open(703), await open(703)];
    const other = await open(704);
    let leaked = false;
    other.ws.addEventListener("message", () => (leaked = true));
    const got = Promise.all([a.next(), b.next()]);
    await push(e, 703, { t: "meme", id: "m1", status: "ready", title: "Cat" });
    expect((await got).map((m) => JSON.parse(m))).toEqual([0, 1].map(() => ({ t: "meme", id: "m1", status: "ready", title: "Cat" })));
    const pong = a.next();
    a.ws.send("ping");
    expect(await pong).toBe("pong");
    expect(leaked).toBe(false);
  });
});
