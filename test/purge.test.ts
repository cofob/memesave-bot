import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../src/db";
import type { Env } from "../src/env";
import { deleteAccount, purgeStage } from "../src/purge";
import { handleAccount } from "../src/webaccount";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const deleted: string[] = [];
  const jobs: any[] = [];
  const telegram: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    telegram.push(String(input).split("/").pop()!);
    return Response.json({ ok: true, result: true });
  });
  const e = {
    ...env,
    VECTORS: { deleteByIds: async (ids: string[]) => void deleted.push(...ids) },
    JOBS: { send: async (b: unknown) => void jobs.push(b) },
  } as unknown as Env;
  return { e, deleted, jobs, telegram };
}

const meme = (e: Env, id: string, userId: number, key: string) =>
  e.DB.prepare("INSERT INTO memes (id, user_id, kind, file_id, file_unique_id, r2_file, status) VALUES (?, ?, 'photo', '', ?, ?, 'ready')")
    .bind(id, userId, `u-${id}`, key)
    .run();
const user = (e: Env, id: number) => e.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();

describe("delete all data", () => {
  it("deletes the account at once and purges memes, vectors and files in the background", async () => {
    const { e, deleted, jobs, telegram } = setup();
    await e.DB.prepare("INSERT INTO users (id, role, sub_charge_id, sub_state) VALUES (51, 'paid', 'ch', 'active'), (52, 'user', NULL, NULL)").run();
    await e.DB.prepare("INSERT INTO transactions (user_id, kind, model, key_source, cost) VALUES (51, 'embed', 'm', 'global', 1), (52, 'embed', 'm', 'global', 1)").run();
    await e.DB.prepare("INSERT INTO payments (user_id, method, kind, usd, charge_id) VALUES (51, 'stars', 'monthly', 1, 'c51')").run();
    await e.DB.prepare("INSERT INTO exports (id, user_id, status) VALUES ('x51', 51, 'done')").run();
    await meme(e, "a", 51, "u/51/a.jpg");
    await meme(e, "b", 52, "u/52/b.jpg");
    for (const k of ["u/51/a.jpg", "u/51/orphan.jpg", "u/52/b.jpg", "tmp/export/x51.zip"]) await e.MEDIA.put(k, "x");

    await deleteAccount(e, (await user(e, 51))!);
    expect(telegram).toEqual(["editUserStarSubscription"]);
    expect(await user(e, 51)).toBeNull();
    expect(await user(e, 52)).not.toBeNull();
    for (const table of ["transactions", "payments", "exports"]) {
      expect(await e.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = 51`).first("n")).toBe(0);
    }
    expect(await e.DB.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = 52").first("n")).toBe(1);
    expect(await e.MEDIA.head("tmp/export/x51.zip")).toBeNull();
    expect(await e.DB.prepare("SELECT user_id, status FROM memes WHERE id = 'a'").first()).toEqual({ user_id: -51, status: "failed" });
    expect(jobs).toEqual([{ type: "purge", userId: 51, before: expect.any(Number) }]);

    // The user came back and saved the same file again before the purge ran.
    await meme(e, "c", 51, "u/51/a.jpg");
    await purgeStage(e, 51, jobs[0].before);
    expect(deleted).toEqual(["a:i", "a:t"]);
    expect((await e.DB.prepare("SELECT id FROM memes ORDER BY id").all()).results).toEqual([{ id: "b" }, { id: "c" }]);
    expect(await e.MEDIA.head("u/51/a.jpg")).not.toBeNull(); // still used by the new meme
    expect(await e.MEDIA.head("u/52/b.jpg")).not.toBeNull();
    expect(await e.MEDIA.head("u/51/orphan.jpg")).toBeNull();
    await e.MEDIA.put("u/51/new.jpg", "x");
    await purgeStage(e, 51, jobs[0].before - 1); // objects uploaded after `before` belong to the new account
    expect(await e.MEDIA.head("u/51/new.jpg")).not.toBeNull();
  });

  it("needs the typed phrase in the web app", async () => {
    const { e, jobs } = setup();
    await e.DB.prepare("INSERT INTO users (id, role) VALUES (53, 'user')").run();
    const u = (await user(e, 53))!;
    const post = (confirm: string) =>
      handleAccount(new Request("https://m.example/app/api/account/delete", { method: "POST", body: JSON.stringify({ confirm }) }), e, u, ["account", "delete"]);
    expect((await post("delete"))!.status).toBe(400);
    expect(await user(e, 53)).not.toBeNull();
    expect((await post("DELETE"))!.status).toBe(200);
    expect(await user(e, 53)).toBeNull();
    expect(jobs).toHaveLength(1);
  });
});
