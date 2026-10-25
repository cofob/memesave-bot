import type { MemeBrief } from "./api";

// Same rules as the server list filters (src/filters.ts), used for search results in the browser.
export interface Filters {
  kind: string[];
  status: string[];
  orient: string[];
  text: string[];
  lang: string[];
  dur: string[];
  added: string; // days, "" = any time
}

export const emptyFilters = (): Filters => ({ kind: [], status: [], orient: [], text: [], lang: [], dur: [], added: "" });

export const groups = ["kind", "status", "orient", "text", "dur", "lang"] as const;
export type Group = (typeof groups)[number];

export const activeCount = (f: Filters) => groups.reduce((n, g) => n + f[g].length, 0) + (f.added ? 1 : 0);

export function toQuery(f: Filters): Record<string, string> {
  const q: Record<string, string> = {};
  for (const g of groups) if (f[g].length) q[g] = f[g].join(",");
  if (f.added) q.added = f.added;
  return q;
}

const orientOf = (m: MemeBrief) =>
  !m.width || !m.height ? null : m.width > m.height * 1.1 ? "landscape" : m.height > m.width * 1.1 ? "portrait" : "square";
const durOf = (m: MemeBrief) =>
  m.kind === "photo" || m.duration === null ? null : m.duration < 10 ? "short" : m.duration <= 60 ? "medium" : "long";
const statusOf = (m: MemeBrief) => (m.status === "ready" || m.status === "failed" ? m.status : "processing");

export function matches(m: MemeBrief, f: Filters) {
  const test = (values: string[], v: string | null) => !values.length || (v !== null && values.includes(v));
  return (
    test(f.kind, m.kind) &&
    test(f.status, statusOf(m)) &&
    test(f.orient, orientOf(m)) &&
    test(f.text, m.has_text ? "yes" : "no") &&
    test(f.lang, m.language) &&
    test(f.dur, durOf(m)) &&
    (!f.added || m.created_at > Date.now() / 1000 - Number(f.added) * 86400)
  );
}
