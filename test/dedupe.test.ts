import { env } from "cloudflare:test";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { embedStage, hashStage } from "../src/ingest/embed";

afterEach(() => vi.restoreAllMocks());

const e = { ...env, VECTORS: { deleteByIds: async () => ({}) } as unknown as Vectorize } as Env;
const sha = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");

describe("sha256 dedupe for forwarded memes", () => {
  it("removes a new meme with the same bytes and says it is already saved", async () => {
    await e.DB.prepare("INSERT INTO users (id, role, lang) VALUES (71, 'user', 'en')").run();
    await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, sha256) VALUES ('old', 71, 'photo', 'f0', 'u0', 'ready', ?)")
      .bind(await sha("SAME"))
      .run();
    await e.DB.prepare(
      "INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status, status_msg_id) VALUES ('new', 71, 'photo', 'f1', 'u1', 'embedding', 5)",
    ).run();
    const telegram: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/getFile")) return Response.json({ ok: true, result: { file_path: "photos/x.jpg" } });
      if (url.includes("/file/bot")) return new Response("SAME");
      telegram.push(url.split("/").pop()!);
      return Response.json({ ok: true, result: true });
    });

    await embedStage(e, "new");
    expect(await e.DB.prepare("SELECT id FROM memes WHERE id = 'new'").first()).toBeNull();
    expect(telegram).toEqual(["editMessageText"]);
  });

  it("backfills hashes of existing memes", async () => {
    await e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, status) VALUES ('b1', 72, 'photo', 'f', 'u-b1', 'ready')").run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/getFile") ? Response.json({ ok: true, result: { file_path: "p.jpg" } }) : new Response("B1"),
    );
    await hashStage(e, "b1");
    expect(await e.DB.prepare("SELECT sha256 FROM memes WHERE id = 'b1'").first<string>("sha256")).toBe(await sha("B1"));
  });
});
