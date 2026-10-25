import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiKey, decrypt, encrypt, setUserKey } from "../src/userkey";

describe("user OpenRouter key", () => {
  it("encrypts round trip", async () => {
    const sealed = await encrypt("secret", "sk-or-1");
    expect(sealed).not.toContain("sk-or");
    expect(await decrypt("secret", sealed)).toBe("sk-or-1");
  });

  it("uses the user key when set, else the global key", async () => {
    await env.DB.prepare("INSERT INTO users (id, role) VALUES (11, 'user')").run();
    expect(await apiKey(env, 11)).toEqual({ key: env.OPENROUTER_API_KEY, source: "global" });
    await setUserKey(env, 11, "sk-or-user");
    expect(await apiKey(env, 11)).toEqual({ key: "sk-or-user", source: "user" });
    await setUserKey(env, 11, null);
    expect(await apiKey(env, 11)).toEqual({ key: env.OPENROUTER_API_KEY, source: "global" });
  });
});
