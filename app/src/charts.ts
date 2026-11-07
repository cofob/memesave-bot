// ECharts option builders for the analytics mode. Thin marks, rounded bar ends, 2 px lines, recessive axes.
import { fill, s, usd } from "./strings";

// Categorical slots in fixed order (validated for CVD on light and dark surfaces); gray for "other".
export const PALETTE = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
export const OTHER = "#a1a1aa";

/** The app theme: Telegram sets data-theme, a browser follows the OS. */
export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

type Fmt = (v: number) => string;
const plain: Fmt = (v) => v.toLocaleString();
export const money: Fmt = (v) => usd(v);

const axis = { axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { opacity: 0.3 } } };

/** Sequential single-hue ramp, light → dark on a light surface (and the reverse on a dark one). */
export const sequential = () => (isDark() ? ["#1e3550", "#3987e5", "#cfe3fb"] : ["#e6f0fb", "#2a78d6", "#0d3d78"]);

export const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

/** Every day from the first to the last one in the rows (charts need the empty days too). */
export function dayRange(days: string[]): string[] {
  if (!days.length) return [];
  const sorted = [...days].sort();
  const out: string[] = [];
  for (let d = new Date(sorted[0]); d <= new Date(sorted[sorted.length - 1]); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/** The 7 largest groups by total and "other": categorical slots are never cycled. */
export function topGroups<T>(rows: T[], group: (r: T) => string, value: (r: T) => number, limit = 7, order?: string[]) {
  const total = new Map<string, number>();
  for (const r of rows) total.set(group(r), (total.get(group(r)) ?? 0) + value(r));
  // A fixed order (meme kinds, sources) keeps each group's color: color follows the entity, not its rank.
  const top = order ? order.filter((g) => total.has(g)) : [...total.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  const keep = new Set(top.slice(0, limit));
  return { names: top.length > limit ? [...keep, s.anOther] : [...keep], of: (r: T) => (keep.has(group(r)) ? group(r) : s.anOther) };
}

/** Stacked bars over a category axis (days or months), one series per group. */
export function stacked<T>(rows: T[], x: (r: T) => string, group: (r: T) => string, value: (r: T) => number, opts: { xs?: string[]; fmt?: Fmt; order?: string[]; muted?: string } = {}) {
  // Long day ranges are summed by week (up to 2 years) or month: hundreds of thin daily bars are only noise.
  const unit = periodOf(opts.xs);
  const key = (d: string) => periodKey(d, unit);
  const xs = opts.xs ? [...new Set(opts.xs.map(key))] : [...new Set(rows.map(x))].sort();
  const pos = new Map(xs.map((v, i) => [v, i]));
  const g = topGroups(rows, group, value, 7, opts.order);
  const data = new Map(g.names.map((n) => [n, xs.map(() => 0)]));
  for (const r of rows) data.get(g.of(r))![pos.get(key(x(r)))!] += value(r);
  const fmt = opts.fmt ?? plain;
  return {
    legend: { show: g.names.length > 1, top: 0, type: "scroll" },
    tooltip: {
      trigger: "axis",
      formatter: (ps: any[]) =>
        `${esc(periodLabel(ps[0].name, unit))}<br>` +
        ps
          .filter((p) => p.value)
          .map((p) => `${p.marker}${esc(p.seriesName)} <b>${fmt(p.value)}</b>`)
          .join("<br>"),
    },
    xAxis: { type: "category", data: xs, ...axis },
    yAxis: { type: "value", ...axis, axisLabel: { formatter: fmt } },
    dataZoom: xs.length > 60 ? [{ type: "inside" }] : [],
    series: g.names.map((name) => ({
      name,
      type: "bar",
      stack: "total",
      barMaxWidth: 24,
      itemStyle: { borderRadius: 0, ...((name === s.anOther || name === opts.muted) && { color: OTHER }) },
      emphasis: { focus: "series" },
      data: data.get(name),
    })),
  };
}

/** One line over a category axis, e.g. a running total. */
export function line(xs: string[], values: number[], name: string, fmt: Fmt = plain) {
  return {
    tooltip: { trigger: "axis", valueFormatter: fmt },
    xAxis: { type: "category", data: xs, boundaryGap: false, ...axis },
    yAxis: { type: "value", ...axis, axisLabel: { formatter: fmt } },
    dataZoom: xs.length > 60 ? [{ type: "inside" }] : [],
    series: [{ name, type: "line", data: values, showSymbol: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.12 } }],
  };
}

export const cumulative = (v: number[]) => v.map(((sum) => (x: number) => (sum += x))(0));

/** Horizontal bars of named values, largest first. */
export function bars(items: { name: string; value: number }[], name: string, fmt: Fmt = plain) {
  const sorted = [...items].sort((a, b) => a.value - b.value); // the axis draws bottom-up
  return {
    tooltip: { trigger: "item", valueFormatter: fmt },
    grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
    // The bars carry their values: no value axis labels (they collide on narrow cards).
    xAxis: { type: "value", ...axis, axisLabel: { show: false } },
    yAxis: { type: "category", data: sorted.map((i) => i.name), ...axis, axisLabel: { width: 140, overflow: "truncate" } },
    series: [
      {
        name,
        type: "bar",
        data: sorted.map((i) => i.value),
        barMaxWidth: 18,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", formatter: (p: any) => fmt(p.value) },
      },
    ],
  };
}

/** Vertical bars over ordered buckets (histograms). */
export function columns(xs: string[], values: number[], name: string) {
  return {
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: xs, ...axis },
    yAxis: { type: "value", ...axis },
    series: [{ name, type: "bar", data: values, barMaxWidth: 32, barCategoryGap: "8%", itemStyle: { borderRadius: [4, 4, 0, 0] } }],
  };
}

/** A histogram of {edges, counts} with bucket midpoints as labels. */
export const histogram = (h: { edges: number[]; counts: number[] }, name: string) =>
  columns(
    h.counts.map((_, i) => ((h.edges[i] + h.edges[i + 1]) / 2).toFixed(2)),
    h.counts,
    name,
  );

/** A heatmap of a matrix with one sequential hue. */
export function heatmap(xs: string[], ys: string[], cells: [number, number, number][], name: string) {
  const max = Math.max(1, ...cells.map((c) => c[2]));
  return {
    tooltip: { trigger: "item", formatter: (p: any) => `${esc(ys[p.value[1]])} · ${esc(xs[p.value[0]])}: <b>${p.value[2]}</b>` },
    grid: { left: 8, right: 8, top: 8, bottom: 48, containLabel: true },
    xAxis: { type: "category", data: xs, ...axis, splitArea: { show: false }, axisLabel: { rotate: xs.length > 24 ? 60 : 0 } },
    yAxis: { type: "category", data: ys, ...axis },
    visualMap: { min: 0, max, calculable: false, orient: "horizontal", left: "center", bottom: 0, itemHeight: 120, inRange: { color: sequential() } },
    series: [{ name, type: "heatmap", data: cells, itemStyle: { borderWidth: 2, borderColor: isDark() ? "#1a1a19" : "#fcfcfb" } }],
  };
}

/** Height of a chart: horizontal bars grow with their rows (no empty space for a few rows); others are fixed. */
export function autoHeight(option: any) {
  const rows = option?.xAxis?.type === "value" && option?.yAxis?.type === "category" ? option.yAxis.data?.length : 0;
  return rows ? `${Math.max(120, rows * 30 + (option.legend ? 88 : 56))}px` : "280px";
}

type Period = "day" | "week" | "month";

/** The bar period for a range of days: day up to ~4 months, week up to 2 years, then month. */
function periodOf(days?: string[]): Period {
  if (!days?.length || !/^\d{4}-\d{2}-\d{2}$/.test(days[0])) return "day";
  return days.length > 730 ? "month" : days.length > 120 ? "week" : "day";
}

/** The period of a day: itself, the Monday of its week, or its month ("2026-09"). */
function periodKey(day: string, unit: Period) {
  if (unit === "month") return day.slice(0, 7);
  if (unit === "day") return day;
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const periodLabel = (key: string, unit: Period) => (unit === "week" ? fill(s.anWeekOf, { date: key }) : key);

/** "#2a78d6" with an alpha 0..1 as an rgba() color. */
export const hexAlpha = (hex: string, a: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",")},${a.toFixed(2)})`;
