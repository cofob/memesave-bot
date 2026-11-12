import { paywall } from "./paywall.svelte";
import { tg } from "./telegram";
import { viewing } from "./viewing.svelte";

export type Kind = "photo" | "video" | "animation";

export interface MemeBrief {
  id: string;
  kind: Kind;
  title: string | null;
  status: string;
  tags: string[];
  thumb: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  language: string | null;
  has_text: boolean;
  porn: boolean;
  created_at: number;
  album?: number; // memes in its media group (browsing shows an album as its first meme)
}

export interface MemeDetail extends Omit<MemeBrief, "album"> {
  caption: string | null;
  source: string | null;
  saved_at: number | null; // when it was saved at the source (e.g. the TikTok like)
  description: string | null;
  ocr_text: string | null;
  speech_text: string | null;
  meme_context: string | null;
  cultural_meaning: string | null;
  search_phrases: string[];
  file: string | null;
  audio: string | null; // sound of the photo, shared by its album
  album: FeedMedia[]; // the media group in order, empty for a single meme
  layout?: Layout;
  source_meta?: { site: string; tags: string[] } | null; // import source (Telegraph, e621, …)
}

export interface IndexItem extends MemeBrief {
  ocr_text: string;
  phrases: string;
  caption: string;
}

export type SearchMode = "fts" | "fast" | "advanced";

export interface Page {
  items: MemeBrief[];
  next_offset: number | null;
}

export type Sort = "new" | "old" | "title";
export type Layout = "carousel" | "comic"; // an album: a swipe row, or pages top to bottom
export type FeedMode = "new" | "old" | "random" | "favorites" | "forgotten" | "time" | "unseen" | "porn";
/** A feed media: the file URL (null for Telegram-only files over 20 MB). */
export interface FeedMedia extends MemeBrief {
  file: string | null;
}
/** A feed meme: the media, use count and date (saved_at, else created_at); an album has all its memes in slides. */
export interface FeedItem extends FeedMedia {
  slides?: FeedMedia[];
  audio: string | null;
  uses: number;
  date: number;
  layout?: Layout;
}
export type PairFeedMode = "mix" | "theirs" | "twins" | "rhymes" | "foryou" | "surprise" | "bridge" | "guess";
export type Owner = "me" | "partner";
/** owner: omitted in the solo feed and in the pair "guess" mode. */
export interface PairFeedItem extends FeedItem {
  owner?: Owner;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Mini App: signed initData; web: the session cookie from Telegram Login (sent automatically).
const authHeaders = (): Record<string, string> => (tg ? { Authorization: `tma ${tg.initData}` } : {});

// Reads of the meme library go to the viewed partner's memes.
const OWNED = /^(memes|index|tags|facets|search)\b/;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!init.method && OWNED.test(path) && viewing.who && !/[?&]owner=/.test(path)) path += `${path.includes("?") ? "&" : "?"}owner=${viewing.who.id}`;
  const headers = { ...authHeaders(), ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}) };
  const res = await fetch(`/app/api/${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 402) paywall.reason = text.includes('"credit"') ? "credit" : "subscribe";
    throw new ApiError(res.status, text);
  }
  return res.json();
}

export interface Me {
  id: number;
  username: string | null;
  role: "admin" | "user" | "paid";
  search_mode: "advanced" | "fast";
  describe_tier: "max" | "medium";
  hide_porn: boolean;
  key: boolean;
  models: Record<string, string>;
  billing: Billing;
}

export interface Channel {
  chat_id: number;
  title: string | null;
  username: string | null;
  enabled: number;
  caption: string;
  storage: number;
}

export interface Connection {
  id: string;
  client: string;
  domain: string | null;
  scope: string[];
  created_at: number;
}

export interface E621Status {
  connected: boolean;
  username?: string;
  backfill_done?: boolean; // false: the first full import (or the daily rescan) is running
  last_sync?: number;
  imported?: number; // posts handled so far
  error?: string | null; // unauthorized | payment required | storage full
}

export interface ApiToken {
  id: string;
  name: string;
  write: boolean;
  created_at: number;
  used_at: number | null;
}

export type ProductKind = "monthly" | "yearly" | "topup";

export interface Billing {
  free: boolean;
  active: boolean;
  plan: "monthly" | "yearly" | null;
  byok: boolean;
  ownKey: boolean;
  paidUntil: number | null;
  subState: "active" | "canceled" | "failed" | null;
  balance: number;
  allowance: number;
  allowanceLeft: number;
  prices: Record<"monthly" | "yearly", { usd: number; stars: number }>;
  starTopups: { stars: number; usd: number }[];
  cryptoTopups: number[];
  methods: { btcpay: boolean; usdt: string[] };
}

export interface CryptoInvoice {
  id: string;
  url: string; // BTCPay checkout page
}

export interface Stats {
  total: number;
  photo: number;
  video: number;
  animation: number;
  pending: number;
  failed: number;
  bytes: number;
  spend: number;
  global: number;
  own: number;
  spend30: number;
  avg: number;
  kinds: { kind: string; cost: number; count: number }[];
}

export interface AllStats {
  users: { id: number; username: string | null; memes: number; total_cost: number; global: number }[];
  total: number;
  global: number;
}

type Count = { k: string | null; n: number };

export interface Analytics {
  timeline: { day: string; kind: Kind; n: number }[];
  saved: { day: string; n: number }[];
  heatmap: { wd: number; h: number; n: number }[]; // UTC weekday (0 = Sunday) and hour
  kinds: Count[];
  statuses: Count[];
  languages: Count[];
  sizes: Count[];
  durations: Count[];
  aspect: Count[];
  tags: {
    top: { tag: string; count: number }[];
    perMeme: { tags: number; n: number }[];
    cooc: { tags: string[]; matrix: number[][] };
    trend: { tags: string[]; months: { month: string; counts: Record<string, number> }[] };
  };
  spend: {
    days: { day: string; kind: string; cost: number }[];
    models: { model: string; cost: number; n: number; prompt: number; completion: number }[];
    keys: { k: string; cost: number }[];
    covered: { allowance: number; balance: number; total: number };
    perMeme: { kind: string; per_meme: number }[];
  };
  albums: { size: number; n: number }[];
  stats: Stats; // the /stats numbers of the same snapshot
  origins: {
    kinds: { kind: OriginKind; n: number }[];
    top: { name: string; kind: OriginKind; n: number; uses: number }[];
    months: { month: string; counts: Partial<Record<OriginKind, number>> }[];
  };
  uses: {
    days: { day: string; via: "inline" | "share" | "send"; n: number }[];
    favorites: { id: string; title: string | null; n: number; last: number }[];
    forgotten: { id: string; title: string | null; created_at: number }[];
    ready: number;
    never: number;
    since: number | null; // the first counted use (counting started with this feature)
  };
  added: { month: string; via: AddedVia | "unknown"; n: number }[]; // how memes were saved
}

export type AddedVia = "bot" | "web" | "miniapp" | "api" | "mcp" | "zip" | "pair";

export type OriginKind = "channel" | "group" | "user" | "link" | "direct";

export interface AdminAnalytics {
  users: { day: string; role: string; n: number }[];
  memes: { day: string; kind: Kind; n: number }[];
  statuses: Count[];
  errors: Count[];
  spend: { day: string; model: string; cost: number }[];
  keys: { k: string; cost: number }[];
  payments: { month: string; method: string; usd: number; n: number }[];
  table: AllStats;
}

export interface PairView {
  id: string;
  status: "pending" | "active";
  incoming: boolean; // the viewer can accept or decline it
  partner: { id: number | null; name: string | null; username: string | null }; // id null: an open link nobody accepted yet
  i_share: boolean;
  they_share: boolean;
  created_at: number;
  accepted_at: number | null;
}

interface PairSide {
  id: number;
  name: string | null;
  ready: number;
  kinds: Count[];
  heatmap: { wd: number; h: number; n: number }[];
  months: { month: string; n: number }[];
  languages: Count[];
  durations: Count[];
  aspect: Count[];
  tags: { tag: string; count: number }[];
}

export interface PairStats {
  me: PairSide;
  partner: PairSide;
  shared: {
    tags: { tag: string; me: number; partner: number }[];
    jaccard: number;
    unique_me: { tag: string; count: number }[];
    unique_partner: { tag: string; count: number }[];
    sources: { kind: string; name: string; me: number; partner: number }[];
    twins: { count: number; items: [me_id: string, partner_id: string, me_date: number, partner_date: number][]; first: { me: number; partner: number } };
    hourSim: number;
    monthSim: number;
  };
  compat: number;
}

export interface AnalysisRun {
  id: string;
  status: "running" | "done" | "failed";
  stage: string | null;
  done: number;
  total: number;
  error: string | null;
  labeled: boolean; // clusters have LLM names
  created_at: number;
  fresh_until: number;
  share?: string | null; // public link of this result (the finished one only)
}

/** A public analysis link: a copy without AI spend, sources and meme previews; the sharer is owner 0 (pair: stats.me). */
export type SharedAnalysis = { kind: "solo"; result: AnalysisResult } | { kind: "pair"; result: PairResult; stats: PairStats; names: [string | null, string | null] };

interface Histogram {
  edges: number[];
  counts: number[];
}

export interface Cluster {
  id: number;
  size: number;
  x: number;
  y: number;
  tags: string[];
  sample: string[];
  name?: string; // LLM name and summary (left out when the AI is unavailable)
  summary?: string;
}

export interface AnalysisResult {
  created_at: number;
  count: number;
  memes: [id: string, kind: Kind, created_at: number, language: string][];
  image: { ids: string[]; xy: [number, number][]; xyz?: [number, number, number][] };
  text: { ids: string[]; xy: [number, number][]; xyz?: [number, number, number][]; labels: number[] };
  clusters: Cluster[];
  pca: { image: number[]; text: number[] };
  duplicates: [a: string, b: string, sim: number][];
  outliers: string[];
  alignment: { hist: Histogram; worst: [id: string, sim: number][] };
  similarity: { image: Histogram; text: Histogram };
  tagmap: { tag: string; x: number; y: number; n: number }[];
  trends: { months: string[]; clusters: number[][]; other: number[]; total: number[]; rising: number[]; fading: number[] };
  moods?: PairResult["moods"]; // one owner: a, overall[0], top[0]
  analytics: Analytics; // SQL stats snapshot taken with this analysis
}

export interface PairCluster extends Cluster {
  share: [number, number]; // members per owner
  r: number; // 1 = all owner 0, 0 = all owner 1 (normalized by collection sizes)
  type: "shared" | "a" | "b" | "";
  first: number; // the owner who came here first, -1 same month or one side
}

export interface PairFacts {
  title: string;
  verdict: string;
  facts: string[];
  awards: { name: string; winner: "a" | "b" | "both"; reason: string }[];
}

/** The pair analysis: owner 0 = owners[0] ("a"), 1 = owners[1] ("b"). */
export interface PairResult {
  created_at: number;
  owners: [number, number];
  count: [number, number];
  memes: [id: string, kind: Kind, created_at: number, language: string, owner: number][];
  map: { ids: string[]; xy: [number, number][]; xyz?: [number, number, number][]; labels?: number[]; owner: number[] };
  clusters: PairCluster[];
  scores: { compat: number; mixing: number; centroid: number; moodSim: number; hourSim: number };
  twins: [a: string, b: string, sim: number][];
  rhymes: [a: string, b: string, sim: number][];
  for: [string[], string[]]; // [o]: the other owner's memes closest to o's taste
  surprise: [string[], string[]];
  bridge: string[];
  sync: { months: string[]; sim: number[] };
  influence: { clusters: [number, number]; twins: [number, number]; score: [number, number] };
  moods: {
    keys: string[];
    emoji: string[];
    names: Record<string, string[]>;
    months: string[];
    a: (number[] | null)[];
    b: (number[] | null)[];
    overall: [number[] | null, number[] | null];
    sim: (number | null)[];
    top: [number, number];
    best: string[];
  } | null;
  facts?: Partial<Record<string, PairFacts>>; // by language
  images: string[];
}

export interface ImportRow {
  id: string;
  status: string;
  attempts: number;
  described: number;
  cost: number;
  created_at: number;
  photos: number;
  pending: number;
  failed: number;
  ready: number;
  live: { status: string; total: number; completed: number; failed: number } | null;
}

export interface ZipStatus {
  status: "uploading" | "running" | "done" | "failed";
  total: number | null;
  imported: number;
  skipped: number;
  format: string | null;
  error: string | null;
}

export interface ExportStatus {
  id: string;
  status: "running" | "done" | "failed";
  size: number | null;
  error: string | null;
  created_at: number;
  next_at: number | null;
  url: string | null;
}

export interface UsersList {
  users: { id: number; username: string | null; role: string; total_cost: number; memes: number }[];
  grants: { username: string; role: string }[];
}

const post = <T>(path: string, body?: object) => call<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

export interface UploadMeta {
  thumb?: Blob;
  width?: number;
  height?: number;
  duration?: number;
}

/** Uploads one file with progress (XHR: fetch has no upload progress). */
function upload(file: File, meta: UploadMeta, onProgress: (fraction: number) => void) {
  const form = new FormData();
  form.append("file", file);
  if (meta.thumb) form.append("thumb", meta.thumb, "thumb.jpg");
  for (const key of ["width", "height", "duration"] as const) if (meta[key]) form.append(key, String(meta[key]));
  return new Promise<{ id: string; duplicate: boolean; batched?: boolean }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/app/api/upload");
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 402) paywall.reason = JSON.parse(xhr.responseText).reason;
      return xhr.status === 200 ? resolve(JSON.parse(xhr.responseText)) : reject(new ApiError(xhr.status, xhr.responseText));
    };
    xhr.onerror = () => reject(new ApiError(0, "network error"));
    xhr.send(form);
  });
}

export const api = {
  me: () => call<Me>("me"),
  stats: () => call<Stats>("stats"),
  allStats: () => call<AllStats>("stats?all=1"),
  adminAnalytics: () => call<AdminAnalytics>("analytics?all=1"),
  analysis: () => call<{ current: AnalysisRun | null; ready: AnalysisRun | null }>("analysis"),
  analysisStart: (llm: boolean) => post<AnalysisRun>("analysis", { llm }),
  analysisResult: () => call<AnalysisResult>("analysis/result"),
  analysisShare: (pair?: string) => post<{ id: string; url: string }>(pair ? `pairs/${pair}/analysis/share` : "analysis/share"),
  analysisUnshare: (pair?: string) => call(pair ? `pairs/${pair}/analysis/share` : "analysis/share", { method: "DELETE" }),
  sharedAnalysis: async (sid: string) => {
    const res = await fetch(`/app/shared/analysis/${encodeURIComponent(sid)}`);
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return (await res.json()) as SharedAnalysis;
  },
  setSettings: (settings: Partial<Pick<Me, "search_mode" | "describe_tier" | "hide_porn">>) => call("settings", { method: "PUT", body: JSON.stringify(settings) }),
  channels: () => call<{ channels: Channel[]; addUrl: string }>("channels"),
  setChannel: (id: number, body: { enabled?: boolean; caption?: string; storage?: boolean }) => call(`channels/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  removeChannel: (id: number) => call(`channels/${id}`, { method: "DELETE" }),
  connections: () => call<{ mcp_url: string; items: Connection[] }>("connections"),
  revokeConnection: (id: string) => call(`connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  e621: () => call<E621Status>("e621"),
  connectE621: (username: string, api_key: string) => call("e621", { method: "PUT", body: JSON.stringify({ username, api_key }) }),
  disconnectE621: () => call("e621", { method: "DELETE" }),
  tokens: () => call<ApiToken[]>("tokens"),
  createToken: (name: string, write: boolean) => post<{ id: string; token: string }>("tokens", { name, write }),
  deleteToken: (id: string) => call(`tokens/${id}`, { method: "DELETE" }),
  billing: () => call<Billing>("billing"),
  starsInvoice: (kind: ProductKind, stars?: number) => post<{ url: string }>("billing/invoice", { kind, stars }),
  cryptoInvoice: (body: { provider: "btcpay"; kind: ProductKind; usd?: number; crypto?: string }) => post<CryptoInvoice>("billing/crypto", body),
  cryptoStatus: (id: string) => call<{ id: string; status: string }>(`billing/crypto/${id}`),
  autorenew: (on: boolean) => post("billing/autorenew", { on }),
  connectKey: () => post<{ url: string }>("key"),
  removeKey: () => call("key", { method: "DELETE" }),
  batch: () => call<{ collecting: ImportRow | null; recent: ImportRow[]; failed: number }>("batch"),
  batchRetry: () => post<{ photos: number; others: number }>("batch/retry"),
  batchStart: () => post("batch/start"),
  batchFinish: () => post<{ ok: boolean }>("batch/finish"),
  batchCancel: () => post<{ count: number | null }>("batch/cancel"),
  zipCreate: () => post<{ id: string; url: string }>("zip"),
  zipStatus: (id: string) => call<ZipStatus>(`zip/${id}`),
  exportStatus: () => call<ExportStatus | null>("export"),
  exportStart: () => post<{ id: string }>("export"),
  accountSummary: () => call<{ memes: number; payments: number }>("account"),
  deleteAccount: (confirm: string) => post<{ ok: true }>("account/delete", { confirm }),
  users: () => call<UsersList>("admin/users"),
  grant: (target: string, role: string) => post<{ result: string; target: string }>("admin/grant", { target, role }),
  revoke: (target: string) => post<{ result: string; target: string }>("admin/revoke", { target }),
  retry: (id: string) => post(`memes/${id}/retry`),
  upload,
  status: (ids: string[]) => call<{ id: string; status: string; title: string | null }[]>(`status?ids=${ids.join(",")}`),
  logout: () => fetch("/auth/logout", { method: "POST" }),
  list: (sort: Sort, tag: string | null, offset: number, filters: Record<string, string> = {}) =>
    call<Page>(`memes?${new URLSearchParams({ sort, offset: String(offset), ...(tag ? { tag } : {}), ...filters })}`),
  facets: () => call<{ counts: Record<string, number>; languages: { value: string; count: number }[] }>("facets"),
  // Search and index return porn memes too: the app hides them by the setting and the filters (matches()).
  search: (q: string, mode: SearchMode) => call<Page>(`search?${new URLSearchParams({ q, mode, porn: "yes,no" })}`),
  index: () => call<IndexItem[]>("index?porn=yes,no"),
  tags: () => call<{ tag: string; count: number }[]>("tags"),
  get: (id: string, owner?: number) => call<MemeDetail>(`memes/${id}${owner ? `?owner=${owner}` : ""}`),
  /** newer: the "time" mode above its point (seed), oldest first. */
  feed: (mode: FeedMode, seed: number, offset: number, newer = false) =>
    call<{ items: FeedItem[]; next_offset: number | null }>(
      `feed?${new URLSearchParams({ mode, seed: String(seed), offset: String(offset), ...(newer ? { newer: "1" } : {}) })}`,
    ),
  seen: (ids: string[]) => call<{ ok: true }>("feed/seen", { method: "POST", body: JSON.stringify({ ids }), keepalive: true }),
  pairFeed: (id: string, mode: PairFeedMode, seed: number, offset: number) =>
    call<{ items: PairFeedItem[]; next_offset: number | null; modes: PairFeedMode[] }>(
      `pairs/${id}/feed?${new URLSearchParams({ mode, seed: String(seed), offset: String(offset), tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`,
    ),
  pairFeedSeen: (id: string, ids: string[]) => call<{ ok: true }>(`pairs/${id}/feed/seen`, { method: "POST", body: JSON.stringify({ ids }), keepalive: true }),
  pairGuess: (id: string, memeId: string, owner: Owner) => post<{ correct: boolean; owner: Owner }>(`pairs/${id}/guess`, { id: memeId, owner }),
  /** Copies a partner's meme into the own collection (duplicate: it is already there). */
  copyMeme: (id: string) => post<{ id: string; duplicate: boolean }>(`memes/${id}/copy`),
  share: (id: string) => call<{ id: string }>(`memes/${id}/share`, { method: "POST" }),
  link: (id: string) => post<{ page: string; file: string | null }>(`memes/${id}/link`),
  send: (id: string) => call<{ ok: true }>(`memes/${id}/send`, { method: "POST" }),
  sendAlbum: (id: string) => call<{ ok: true }>(`memes/${id}/send_album`, { method: "POST" }),
  sendClip: (id: string) => call<{ ok: true }>(`memes/${id}/send_clip`, { method: "POST" }),
  clipLink: (id: string) => call<{ url: string }>(`memes/${id}/clip_link`, { method: "POST" }),
  /** Sets (file) or removes (null) the sound of a photo's album. */
  setAudio: (id: string, file: File | null) => {
    const body = new FormData();
    if (file) body.set("audio", file);
    return call<{ audio: string | null }>(`memes/${id}/audio`, file ? { method: "POST", body } : { method: "DELETE" });
  },
  setLayout: (id: string, layout: Layout) => post<{ layout: Layout }>(`memes/${id}/layout`, { layout }),
  remove: (id: string) => call<{ ok: true }>(`memes/${id}`, { method: "DELETE" }),
  /** Changes the given fields of a ready meme. */
  edit: (id: string, patch: Record<string, string | string[] | boolean>) => call<MemeDetail>(`memes/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeMany: (ids: string[]) => post<{ deleted: string[] }>("delete", { ids }),
  pairs: () => call<{ pairs: PairView[]; bot: string }>("pairs"),
  pairInvite: () => post<{ id: string; link: string; prepared: string | null }>("pairs"),
  pairPick: () => post<{ id: string }>("pairs/pick"),
  pairAccept: (id: string) => post<PairView>(`pairs/${id}/accept`),
  pairDecline: (id: string) => post<{ ok: true }>(`pairs/${id}/decline`),
  pairShare: (id: string, on: boolean) => post<PairView>(`pairs/${id}/share`, { on }),
  pairEnd: (id: string) => call<{ ok: true }>(`pairs/${id}`, { method: "DELETE" }),
  pairStats: (id: string) => call<PairStats>(`pairs/${id}/stats`),
  pairAnalysis: (id: string) => call<{ current: AnalysisRun | null; ready: AnalysisRun | null }>(`pairs/${id}/analysis`),
  pairAnalysisStart: (id: string, llm: boolean) => post<AnalysisRun>(`pairs/${id}/analysis`, { llm }),
  pairAnalysisResult: (id: string) => call<PairResult>(`pairs/${id}/analysis/result`),
  pairMemes: (owner: number, ids: string[]) => call<{ items: MemeBrief[] }>(`memes?owner=${owner}&ids=${ids.join(",")}`),
  files: (ids: string[]) => call<{ id: string; name: string; url: string }[]>(`files?ids=${ids.join(",")}`),
};
