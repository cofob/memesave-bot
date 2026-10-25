import MiniSearch from "minisearch";
import { api, type IndexItem, type MemeBrief } from "./api";

// Client-side text index of all memes: instant results on every keystroke.
export const textIndex = $state({ version: 0 });

let index: MiniSearch | null = null;
const docs = new Map<string, MemeBrief>();

export async function loadIndex() {
  const list = await api.index();
  const next = new MiniSearch({
    fields: ["title", "tags", "ocr", "phrases", "caption"],
    searchOptions: { prefix: true, fuzzy: 0.15, boost: { title: 3, tags: 2, ocr: 2, phrases: 1.5 } },
  });
  next.addAll(
    list.map((m: IndexItem) => ({
      id: m.id,
      title: m.title ?? "",
      tags: m.tags.join(" "),
      ocr: m.ocr_text,
      phrases: m.phrases,
      caption: m.caption,
    })),
  );
  docs.clear();
  for (const m of list) docs.set(m.id, m);
  index = next;
  textIndex.version++;
}

/** All words must match (prefix, small typos allowed); falls back to any word. */
export function localSearch(query: string, limit = 60): MemeBrief[] {
  if (!index || !query) return [];
  let hits = index.search(query, { combineWith: "AND" });
  if (!hits.length) hits = index.search(query);
  return hits.slice(0, limit).flatMap((h) => docs.get(h.id as string) ?? []);
}

export function forget(id: string) {
  if (index?.has(id)) index.discard(id);
  docs.delete(id);
  textIndex.version++;
}
