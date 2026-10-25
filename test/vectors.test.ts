import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { upsertVectors } from "../src/ingest/embed";

describe("upsertVectors", () => {
  it("retries Vectorize rate limits and rethrows other errors", async () => {
    let calls = 0;
    const flaky = { VECTORS: { upsert: async () => (++calls < 3 ? Promise.reject(new Error("VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests")) : { count: 1 }) } } as unknown as Env;
    await upsertVectors(flaky, [], async () => {});
    expect(calls).toBe(3);

    const broken = { VECTORS: { upsert: async () => Promise.reject(new Error("bad dimensions")) } } as unknown as Env;
    await expect(upsertVectors(broken, [], async () => {})).rejects.toThrow("bad dimensions");
  });
});
