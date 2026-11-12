import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { upsertEmbedded, upsertVectors } from "../src/ingest/embed";

describe("upsertVectors", () => {
  it("retries Vectorize rate limits and rethrows other errors", async () => {
    let calls = 0;
    const flaky = { VECTORS: { upsert: async () => (++calls < 3 ? Promise.reject(new Error("VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests")) : { count: 1 }) } } as unknown as Env;
    await upsertVectors(flaky, [], async () => {});
    expect(calls).toBe(3);

    const broken = { VECTORS: { upsert: async () => Promise.reject(new Error("bad dimensions")) } } as unknown as Env;
    await expect(upsertVectors(broken, [], async () => {})).rejects.toThrow("bad dimensions");
  });

  it("keeps the vector of a failed upsert: the retry does not embed again", async () => {
    let made = 0;
    let fail = true;
    const e = { MEDIA: env.MEDIA, VECTORS: { upsert: async () => (fail ? Promise.reject(new Error("bad dimensions")) : { count: 1 }) } } as unknown as Env;
    const make = async () => (made++, [0.5, 0.25]);
    await expect(upsertEmbedded(e, "m1:i", { id: "m1:i" }, make)).rejects.toThrow("bad dimensions");
    fail = false;
    await upsertEmbedded(e, "m1:i", { id: "m1:i" }, make);
    expect(made).toBe(1);
  });
});
