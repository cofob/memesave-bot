import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { grant, parseTarget, resolveUser, revoke } from "../src/auth";

const from = (id: number, username?: string) => ({ id, is_bot: false, first_name: "x", username });

describe("auth", () => {
  it("bootstraps the admin and denies unknown users", async () => {
    expect((await resolveUser(env, from(Number(env.ADMIN_ID))))?.user.role).toBe("admin");
    expect(await resolveUser(env, from(42, "stranger"))).toBeNull();
  });

  it("grants by id", async () => {
    expect(await grant(env.DB, { id: 7 }, "user", 1)).toBe(7);
    expect((await resolveUser(env, from(7)))?.user.role).toBe("user");
  });

  it("binds a username grant on first contact, then revokes", async () => {
    expect(await grant(env.DB, parseTarget("@Friend_1")!, "admin", 1)).toBeNull();
    const res = await resolveUser(env, from(99, "friend_1"));
    expect(res).toMatchObject({ created: true, user: { role: "admin", username: "friend_1" } });
    expect(await revoke(env.DB, { username: "friend_1" })).toEqual({ id: 99, removed: true });
    expect(await resolveUser(env, from(99, "friend_1"))).toBeNull();
  });

  it("parses targets", () => {
    expect(parseTarget("123")).toEqual({ id: 123 });
    expect(parseTarget("@ab")).toBeNull();
    expect(parseTarget(undefined)).toBeNull();
  });
});
