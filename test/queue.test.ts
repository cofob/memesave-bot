import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleBatch, isBusy, retryDelay, type Job } from "../src/queue";

/** One queue message whose job throws `error` on its `attempts`-th try. */
async function attempt(error: string, attempts: number) {
  const msg = { body: { type: "purge", userId: 1, before: 0 } as Job, attempts, acked: false, delay: -1 };
  const batch = { messages: [{ ...msg, ack: () => (msg.acked = true), retry: (o: { delaySeconds: number }) => (msg.delay = o.delaySeconds) }] };
  const env = { DB: { prepare: () => { throw new Error(error); }, batch: () => { throw new Error(error); } } } as unknown as Env;
  await handleBatch(batch as unknown as MessageBatch<Job>, env);
  return msg;
}

describe("queue retries", () => {
  it("detects rate limits and a busy D1", () => {
    expect(isBusy(new Error("VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests"))).toBe(true);
    expect(isBusy(new Error("D1_ERROR: Currently processing a long-running import."))).toBe(true);
    expect(isBusy(new Error("Bad description JSON"))).toBe(false);
  });

  it("backs off busy errors up to an hour", () => {
    expect(retryDelay(2, false)).toBe(60);
    expect(retryDelay(1, true)).toBeGreaterThanOrEqual(45);
    expect(retryDelay(9, true)).toBeLessThanOrEqual(4500);
  });

  it("keeps retrying busy errors after the normal attempt limit", async () => {
    const busy = await attempt("Too Many Requests", 3);
    expect([busy.acked, busy.delay >= 180]).toEqual([false, true]);
    expect((await attempt("Too Many Requests", 10)).acked).toBe(true);
    expect((await attempt("boom", 3)).acked).toBe(true);
  });
});
