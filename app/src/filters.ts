import type { MemeBrief } from "./api";

// Same rules as the server list filters (src/filters.ts), used for search results in the browser.
export interface Filters {
  kind: string[];
  status: string[];
  orient: string[];
  text: string[];
  porn: string[];
  lang: string[];
  dur: string[];
  added: string; // days, "" = any time
}

export const emptyFilters = (): Filters => ({ kind: [], status: [], orient: [], text: [], porn: [], lang: [], dur: [], added: "" });

export const groups = ["kind", "status", "orient", "text", "porn", "dur", "lang"] as const;
export type Group = (typeof groups)[number];

export const activeCount = (f: Filters) => groups.reduce((n, g) => n + f[g].length, 0) + (f.added ? 1 : 0);

export function toQuery(f: Filters): Record<string, string> {
  const q: Record<string, string> = {};
  for (const g of groups) if (f[g].length) q[g] = f[g].join(",");
  if (f.added) q.added = f.added;
  return q;
}

export function fromQuery(q: URLSearchParams): Filters {
  const f = emptyFilters();
  for (const g of groups) f[g] = q.get(g)?.split(",").filter(Boolean) ?? [];
  f.added = q.get("added") ?? "";
  return f;
}

const orientOf = (m: MemeBrief) =>
  !m.width || !m.height ? null : m.width > m.height * 1.1 ? "landscape" : m.height > m.width * 1.1 ? "portrait" : "square";
const durOf = (m: MemeBrief) =>
  m.kind === "photo" || m.duration === null ? null : m.duration < 10 ? "short" : m.duration <= 60 ? "medium" : "long";
const statusOf = (m: MemeBrief) => (m.status === "ready" || m.status === "failed" ? m.status : "processing");

/** hidePorn: the user's setting; a porn filter overrides it (as on the server). */
export function matches(m: MemeBrief, f: Filters, hidePorn = false) {
  const test = (values: string[], v: string | null) => !values.length || (v !== null && values.includes(v));
  return (
    test(f.kind, m.kind) &&
    test(f.status, statusOf(m)) &&
    test(f.orient, orientOf(m)) &&
    test(f.text, m.has_text ? "yes" : "no") &&
    test(f.porn.length || !hidePorn ? f.porn : ["no"], m.porn ? "yes" : "no") &&
    test(f.lang, m.language) &&
    test(f.dur, durOf(m)) &&
    (!f.added || m.created_at > Date.now() / 1000 - Number(f.added) * 86400)
  );
}
