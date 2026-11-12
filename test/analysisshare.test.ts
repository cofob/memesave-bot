import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisStatus, resultKey } from "../src/analysis";
import { shareKey } from "../src/analysisshare";
import type { User } from "../src/db";
import type { Env } from "../src/env";
import { pairEnded } from "../src/pairbot";
import { acceptPair, createInvite, endPair } from "../src/pairs";
import { deleteAccount } from "../src/purge";
import { handleApp } from "../src/webapp";

const e = { ...env, PUBLIC_URL: "https://m.example", JOBS: { send: async () => {} } } as unknown as Env;
const db = e.DB;
beforeEach(() => void vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true, result: { message_id: 1 } })));
afterEach(() => vi.restoreAllMocks());

const enc = (s: string) => new TextEncoder().encode(s);
const hmac = async (key: BufferSource, data: string) =>
  new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc(data)));
async function api(userId: number, path: string, method = "GET") {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: "U" }) });
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  params.set("hash", [...(await hmac(await hmac(enc("WebAppData"), e.BOT_TOKEN), check))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return (await handleApp(new Request(`https://m.example/app/api/${path}`, { method, headers: { Authorization: `tma ${params}` } }), e, {} as ExecutionContext))!;
}
const open = async (sid: string) => (await handleApp(new Request(`https://m.example/app/shared/analysis/${sid}`), e, {} as ExecutionContext))!;
const analysis = async (id: string, userId: number, result: object, pairId: string | null = null) => {
  await db.prepare("INSERT INTO analyses (id, user_id, pair_id, status, stage) VALUES (?, ?, ?, 'done', 'done')").bind(id, userId, pairId).run();
  await e.MEDIA.put(resultKey(id), JSON.stringify(result));
};

const solo = {
  count: 3,
  clusters: [{ id: 0, size: 3, tags: ["cat"], sample: ["m1"], name: "Cats" }],
  duplicates: [["m1", "m2", 0.99]],
  outliers: ["m3"],
  alignment: { hist: { edges: [], counts: [] }, worst: [["m1", 0.1]] },
  images: ["per_day"],
  analytics: {
    tags: { top: [{ tag: "cat", count: 3 }] },
    spend: { days: [{ day: "2026-11-01", kind: "describe", cost: 1 }], models: [], keys: [], covered: { allowance: 1, balance: 2, total: 3 }, perMeme: [] },
    origins: { kinds: [], top: [{ name: "Secret channel", kind: "channel", n: 2, uses: 5 }], months: [] },
    uses: { favorites: [{ id: "m1", title: "Fav", n: 5, last: 1 }], forgotten: [{ id: "m2", title: null, created_at: 1 }], ready: 3, never: 2, since: 1 },
    stats: { total: 3, bytes: 10, spend: 3, spend30: 1, avg: 1 },
  },
};

describe("analysis share links", () => {
  it("makes one sanitized public copy per analysis and revokes it", async () => {
    await db.prepare("INSERT INTO users (id, role) VALUES (801, 'user')").run();
    expect((await api(801, "analysis/share", "POST")).status).toBe(404); // nothing to share yet
    await analysis("s801", 801, solo);
    const link = await (await api(801, "analysis/share", "POST")).json<{ id: string; url: string }>();
    expect(link.url).toBe(`https://m.example/?analysis=${link.id}`);
    expect((await (await api(801, "analysis/share", "POST")).json<any>()).id).toBe(link.id);
    expect((await analysisStatus(e, 801)).ready?.share).toBe(link.url);

    const body = await (await open(link.id)).json<any>();
    expect(body.kind).toBe("solo");
    const r = body.result;
    expect(r.analytics.spend.days).toEqual([]);
    expect(r.analytics.stats).toMatchObject({ total: 3, spend: 0, spend30: 0, avg: 0 });
    expect(r.analytics.origins.top).toEqual([]);
    expect([r.analytics.uses.favorites, r.analytics.uses.forgotten, r.duplicates, r.outliers, r.alignment.worst, r.clusters[0].sample]).toEqual([[], [], [], [], [], []]);
    expect(r.clusters[0].name).toBe("Cats");
    expect(r.images).toBeUndefined();

    expect((await api(801, "analysis/share", "DELETE")).status).toBe(200);
    expect((await open(link.id)).status).toBe(404);
    expect(await e.MEDIA.get(shareKey(link.id))).toBeNull();
    expect((await open("nope")).status).toBe(404);
  });

  it("shares a pair analysis for members, from the sharer's side, and drops it when the pair ends", async () => {
    await db.prepare("INSERT INTO users (id, role, lang) VALUES (811, 'user', 'en'), (812, 'user', 'en'), (813, 'user', 'en')").run();
    const p = (await acceptPair(db, (await createInvite(db, 811, "Ann", 812, "Bob"))!.id, 812, "Bob"))!;
    const pairResult = { owners: [811, 812], count: [30, 30], clusters: [{ id: 0, sample: ["x"] }], twins: [["a", "b", 1]], rhymes: [["a", "b", 1]], for: [["a"], ["b"]], surprise: [["a"], ["b"]], bridge: ["a"], images: ["map"] };
    await analysis("p811", 811, pairResult, p.id);
    expect((await api(813, `pairs/${p.id}/analysis/share`, "POST")).status).toBe(403);
    const link = await (await api(812, `pairs/${p.id}/analysis/share`, "POST")).json<{ id: string }>();
    const body = await (await open(link.id)).json<any>();
    expect(body).toMatchObject({ kind: "pair", names: ["Bob", "Ann"], stats: { me: { id: 0 }, partner: { id: 1 }, shared: { sources: [], twins: { items: [] } } } });
    expect(body.result).toMatchObject({ owners: [1, 0], twins: [], rhymes: [], for: [[], []], surprise: [[], []], bridge: [], clusters: [{ sample: [] }] });

    await pairEnded(e, (await endPair(db, p.id, 811))!, 811);
    expect((await open(link.id)).status).toBe(404);
  });

  it("deletes the copies with the account", async () => {
    await db.prepare("INSERT INTO users (id, role) VALUES (821, 'user')").run();
    await analysis("s821", 821, solo);
    const { id } = await (await api(821, "analysis/share", "POST")).json<{ id: string }>();
    await deleteAccount(e, (await db.prepare("SELECT * FROM users WHERE id = 821").first<User>())!);
    expect(await e.MEDIA.get(shareKey(id))).toBeNull();
    expect(await db.prepare("SELECT 1 FROM analysis_shares WHERE id = ?").bind(id).first()).toBeNull();
  });
});
