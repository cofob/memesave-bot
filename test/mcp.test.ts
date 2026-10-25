import { env } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { handleLogin } from "../src/login";
import { createSession } from "../src/session";
import { handleApp } from "../src/webapp";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const jobs: unknown[] = [];
const JOBS = { send: async (b: unknown) => void jobs.push(b) } as unknown as Queue;
const VECTORS = { deleteByIds: async () => ({}) } as unknown as Vectorize;
const e = { ...env, PUBLIC_URL: "https://m.example", JOBS, VECTORS } as Env;

const ORIGIN = "https://m.example";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example/cb";
const MODERN = "2026-07-28";
const b64url = (b: ArrayBuffer) => Buffer.from(new Uint8Array(b)).toString("base64url");

const call = (path: string, init?: RequestInit) => worker.fetch!(new Request(`${ORIGIN}${path}`, init) as never, e, ctx);
const cookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

/** DCR + consent + code exchange; returns the access token. */
async function connect(userId: number, write = true) {
  const reg = await call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Test <client>", token_endpoint_auth_method: "none" }),
  });
  const { client_id } = await reg.json<{ client_id: string }>();
  const verifier = "v".repeat(64);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st",
    scope: "memes:read memes:write",
    resource: RESOURCE,
  });
  const path = `/oauth/authorize?${query}`;

  const anonymous = await call(path);
  expect(anonymous.status).toBe(302);
  expect(anonymous.headers.get("Location")).toBe(`${ORIGIN}/auth/telegram?next=${encodeURIComponent(path)}`);

  const session = `session=${await createSession(e, userId)}`;
  const page = await call(path, { headers: { Cookie: session } });
  const html = await page.text();
  expect(page.status).toBe(200);
  expect(html).toContain("Test &lt;client&gt;");
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];

  const form = new URLSearchParams({ handle, decision: "allow", ...(write ? { write: "1" } : {}) });
  const approved = await call(path, {
    method: "POST",
    body: form,
    headers: { Cookie: `${session}; ${cookies(page)}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  expect(approved.status).toBe(302);
  const back = new URL(approved.headers.get("Location")!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("iss")).toBeTruthy();

  const token = await call("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: REDIRECT, client_id, code_verifier: verifier, resource: RESOURCE }),
  });
  const data = await token.json<{ access_token: string; refresh_token: string; scope: string }>();
  expect(data.refresh_token).toBeTruthy();
  return data.access_token;
}

let id = 0;
/** One modern (2026-07-28) MCP request; returns the JSON-RPC message. */
async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await call("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MODERN,
      "Mcp-Method": method,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return res.json<{ result?: any; error?: any }>();
}

const tool = async (token: string, name: string, args: object = {}) => (await rpc(token, "tools/call", { name, arguments: args })).result;
const names = async (token: string) => ((await rpc(token, "tools/list")).result.tools as { name: string }[]).map((t) => t.name);

beforeAll(async () => {
  await e.DB.batch([
    e.DB.prepare("INSERT INTO users (id, role, username) VALUES (81, 'user', 'mcpuser'), (82, 'user', NULL), (83, 'paid', NULL)"),
    e.DB.prepare(
      `INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, title, tags, width, height) VALUES
       ('m1', 81, 'photo', 'f', 'u-m1', 'ready', 'dancing cat', 'cat', 100, 50),
       ('m2', 81, 'video', 'f', 'u-m2', 'ready', 'sad cat', 'cat', 50, 100),
       ('m3', 82, 'photo', 'f', 'u-m3', 'ready', 'other cat', 'cat', 100, 100)`,
    ),
  ]);
});

describe("MCP OAuth", () => {
  it("publishes metadata and challenges requests without a token", async () => {
    const meta = await (await call("/.well-known/oauth-protected-resource/mcp")).json<{ resource: string }>();
    expect(meta.resource).toBe(RESOURCE);
    const res = await call("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("returns to the consent page after login, never elsewhere", async () => {
    const start = async (next: string) => {
      const res = (await handleLogin(new Request(`${ORIGIN}/auth/telegram?next=${encodeURIComponent(next)}`), e))!;
      const part = res.headers.get("Set-Cookie")!.split(";")[0].split(".")[2];
      return Buffer.from(part, "base64url").toString();
    };
    expect(await start("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x");
    expect(await start("https://evil.example/")).toBe("/");
    expect(await start("//evil.example/oauth/authorize?")).toBe("/");
  });

  it("serves legacy and modern clients", async () => {
    const token = await connect(81);
    const init = await call("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" } },
      }),
    });
    expect(init.status).toBe(200);
    expect(await init.text()).toContain("memesave");
    expect((await rpc(token, "server/discover")).result.supportedVersions).toContain(MODERN);
    expect(await names(token)).toEqual(expect.arrayContaining(["search_memes", "list_memes", "view_meme", "upload_meme", "delete_memes"]));
  });

  it("hides write tools from a read-only connection", async () => {
    const tools = await names(await connect(81, false));
    expect(tools).toContain("search_memes");
    expect(tools).not.toContain("upload_meme");
    expect(tools).not.toContain("delete_memes");
  });

  it("lists, searches and changes only the user's memes", async () => {
    const token = await connect(81);
    const list = await tool(token, "list_memes", { filters: { orient: ["landscape"] } });
    expect(list.structuredContent.items.map((m: { id: string }) => m.id)).toEqual(["m1"]);

    const found = await tool(token, "search_memes", { query: "cat", mode: "fts" });
    expect(found.structuredContent.items.map((m: { id: string }) => m.id).sort()).toEqual(["m1", "m2"]);
    const videos = await tool(token, "search_memes", { query: "cat", mode: "fts", filters: { kind: ["video"] } });
    expect(videos.structuredContent.items.map((m: { id: string }) => m.id)).toEqual(["m2"]);

    expect((await tool(token, "get_meme", { id: "m3" })).isError).toBe(true);
    expect((await tool(token, "get_meme", { id: "m1" })).structuredContent.title).toBe("dancing cat");

    const deleted = await tool(token, "delete_memes", { ids: ["m2", "m3"] });
    expect(deleted.structuredContent.deleted).toEqual(["m2"]);
    expect(await e.DB.prepare("SELECT id FROM memes WHERE id = 'm3'").first()).not.toBeNull();
  });

  it("uploads base64 data and gates AI work on payment", async () => {
    const token = await connect(81);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const res = await tool(token, "upload_meme", { data: png.toString("base64"), mime_type: "image/png" });
    expect(res.structuredContent).toMatchObject({ duplicate: false });
    expect(jobs).toContainEqual({ type: "embed", memeId: res.structuredContent.id });

    const unpaid = await connect(83);
    expect((await tool(unpaid, "search_memes", { query: "cat", mode: "fast" })).content[0].text).toContain("payment required");
    expect((await tool(unpaid, "upload_meme", { data: png.toString("base64"), mime_type: "image/png" })).isError).toBe(true);
    expect((await tool(unpaid, "search_memes", { query: "cat", mode: "fts" })).isError).toBeFalsy();
  });

  it("lists connections in the app and revokes them", async () => {
    const token = await connect(82);
    const req = (method = "GET", path = "connections") =>
      handleApp(new Request(`${ORIGIN}/app/api/${path}`, { method, headers: { Cookie: `session=${createdSession}` } }), e, ctx);
    const createdSession = await createSession(e, 82);
    const { items, mcp_url } = await (await req())!.json<{ items: { id: string; client: string; scope: string[] }[]; mcp_url: string }>();
    expect(mcp_url).toBe(RESOURCE);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ client: "Test <client>", scope: ["memes:read", "memes:write"] });

    expect((await rpc(token, "tools/list")).result).toBeTruthy();
    await req("DELETE", `connections/${encodeURIComponent(items[0].id)}`);
    const res = await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
    expect(res.status).toBe(401);
  });
});
