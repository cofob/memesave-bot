// Metadata filters for the app list: ?kind=&status=&orient=&text=&lang=&added=&dur= (lists are comma separated).
// The client applies the same rules to search results (app/src/filters.ts).

const SQL: Record<string, Record<string, string>> = {
  kind: { photo: "kind = 'photo'", video: "kind = 'video'", animation: "kind = 'animation'" },
  status: { ready: "status = 'ready'", processing: "status IN ('embedding', 'describing')", failed: "status = 'failed'" },
  orient: {
    landscape: "width > height * 1.1",
    portrait: "height > width * 1.1",
    square: "width BETWEEN height * 0.9 AND height * 1.1",
  },
  text: { yes: "COALESCE(ocr_text, '') != ''", no: "COALESCE(ocr_text, '') = ''" },
  dur: { short: "kind != 'photo' AND duration < 10", medium: "kind != 'photo' AND duration BETWEEN 10 AND 60", long: "kind != 'photo' AND duration > 60" },
};

const list = (url: URL, key: string) => (url.searchParams.get(key) ?? "").split(",").filter(Boolean);

/** WHERE parts and their parameters; values inside one group are OR-ed, groups are AND-ed. */
export function filterSql(url: URL): { where: string[]; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  for (const [key, options] of Object.entries(SQL)) {
    const parts = list(url, key).flatMap((v) => options[v] ?? []);
    if (parts.length) where.push(`(${parts.map((p) => `(${p})`).join(" OR ")})`);
  }
  const langs = list(url, "lang").slice(0, 20);
  if (langs.length) {
    where.push(`language IN (${langs.map(() => "?").join(",")})`);
    params.push(...langs);
  }
  const days = Number(url.searchParams.get("added"));
  if (days > 0) {
    where.push("created_at > unixepoch() - ?");
    params.push(Math.round(days * 86400));
  }
  return { where, params };
}

/** Counts for the filter options of one user. */
export async function facets(db: D1Database, userId: number) {
  const count = (expr: string) => `SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END)`;
  const columns = Object.entries(SQL).flatMap(([key, options]) =>
    Object.entries(options).map(([value, expr]) => `${count(expr)} AS "${key}:${value}"`),
  );
  const [totals, langs] = await db.batch<Record<string, number | string>>([
    db.prepare(`SELECT COUNT(*) AS total, ${columns.join(", ")} FROM memes WHERE user_id = ?`).bind(userId),
    db.prepare(
      "SELECT language, COUNT(*) AS n FROM memes WHERE user_id = ? AND language IS NOT NULL AND language != 'none' GROUP BY language ORDER BY n DESC, language LIMIT 20",
    ).bind(userId),
  ]);
  return {
    counts: Object.fromEntries(Object.entries(totals.results[0] ?? {}).map(([k, v]) => [k, Number(v ?? 0)])),
    languages: langs.results.map((r) => ({ value: String(r.language), count: Number(r.n) })),
  };
}
