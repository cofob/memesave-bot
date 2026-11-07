<script lang="ts">
  import { Button, Heading, Inline, Select, Stack, Tag } from "@cofob2/design-system-svelte";
  import { Trash2 } from "@lucide/svelte";
  import { api, type AnalysisResult, type Kind } from "./api";
  import Chart from "./Chart.svelte";
  import { esc, hexAlpha, histogram, isDark, OTHER, PALETTE, sequential } from "./charts";
  import Scatter3D from "./Scatter3D.svelte";
  import Thumbs from "./Thumbs.svelte";
  import { indexed, textIndex } from "./search.svelte";
  import { fill, s } from "./strings";
  import { confirm } from "./telegram";

  interface Props {
    result: AnalysisResult;
    onOpen: (id: string) => void;
    onTag: (tag: string) => void;
  }
  let { result, onOpen, onTag }: Props = $props();

  let space = $state<"text" | "image">("text");
  let color = $state<"cluster" | "kind" | "lang" | "date">("cluster");
  let view = $state<"2d" | "3d">("2d");
  let removed = $state<string[]>([]);

  const has3d = $derived(!!result[space].xyz?.length);

  const meta = $derived(new Map(result.memes.map((m) => [m[0], m])));
  const clusterOf = $derived(new Map(result.text.ids.map((id, i) => [id, result.text.labels?.[i] ?? -1])));
  const clusterName = (c: { name?: string; tags: string[] }) => c.name ?? c.tags.slice(0, 3).join(", ");

  /** Tooltip with the meme preview from the loaded index. */
  function preview(id: string, extra = "") {
    void textIndex.version;
    const m = indexed(id);
    const img = m ? `<img src="${esc(m.thumb)}" alt="" style="display:block;width:140px;height:140px;object-fit:cover;border-radius:6px;margin-bottom:4px">` : "";
    return `${img}<div style="max-width:140px;white-space:normal">${esc(m?.title ?? id)}${extra}</div>`;
  }

  /** Per-point group and color for both views: the 7 largest groups get slots in fixed order, the rest is
   * "other"; by date, one sequential hue. */
  const coloring = $derived.by(() => {
    const sp = result[space];
    const palette = isDark() ? PALETTE.dark : PALETTE.light;
    if (color === "date") {
      const times = sp.ids.map((id) => meta.get(id)?.[2] ?? 0);
      const lo = Math.min(...times);
      const hi = Math.max(...times);
      const ramp = sequential();
      return {
        legend: [] as { name: string; color: string }[],
        group: sp.ids.map(() => s.anByDate),
        colors: times.map((t) => mix(ramp, hi > lo ? (t - lo) / (hi - lo) : 1)),
        range: [lo, hi] as [number, number],
      };
    }
    const groupOf = (id: string): string => {
      const m = meta.get(id);
      if (color === "kind") return ({ photo: s.statPhotos, video: s.statVideos, animation: s.statGifs } as Record<Kind, string>)[m?.[1] ?? "photo"];
      if (color === "lang") return m?.[3] ? m[3].toUpperCase() : "—";
      const cl = result.clusters.find((x) => x.id === (clusterOf.get(id) ?? -1));
      return cl ? clusterName(cl) : s.anNoise;
    };
    const raw = sp.ids.map(groupOf);
    const size = new Map<string, number>();
    for (const g of raw) size.set(g, (size.get(g) ?? 0) + 1);
    const top = [...size.entries()].filter(([g]) => g !== s.anNoise).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([g]) => g);
    const group = raw.map((g) => (top.includes(g) ? g : g === s.anNoise ? s.anNoise : s.anOther));
    const colorOf = (g: string) => (top.includes(g) ? palette[top.indexOf(g)] : OTHER);
    const legend = [...top, s.anOther, s.anNoise].filter((g) => size.has(g) || (g === s.anOther && group.includes(g))).map((name) => ({ name, color: colorOf(name) }));
    return { legend, group, colors: group.map(colorOf), range: null };
  });

  /** A color of a ramp (hex stops) at t in 0..1. */
  function mix(stops: string[], t: number) {
    const f = Math.min(stops.length - 1.001, t * (stops.length - 1));
    const [a, b] = [stops[Math.floor(f)], stops[Math.floor(f) + 1]].map((h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)));
    return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * (f % 1))).join(",")})`;
  }

  const map = $derived.by(() => {
    const sp = result[space];
    const c = coloring;
    const base = { type: "scatter", symbolSize: 5, emphasis: { scale: 2 } };
    const series =
      c.range
        ? [{ ...base, name: s.anByDate, data: sp.ids.map((id, i) => ({ value: sp.xy[i], id, itemStyle: { color: c.colors[i], opacity: 0.85 } })) }]
        : c.legend.map(({ name, color }) => ({
            ...base,
            name,
            itemStyle: { color, opacity: color === OTHER ? 0.45 : 0.8 },
            data: sp.ids.flatMap((id, i) => (c.group[i] === name ? [{ value: sp.xy[i], id }] : [])),
          }));
    return {
      legend: { top: 0, type: "scroll", show: !c.range },
      tooltip: { trigger: "item", formatter: (p: any) => p.data?.id && preview(p.data.id, `<br><small>${esc(p.seriesName)}</small>`) },
      grid: { left: 8, right: 8, top: 32, bottom: 8 },
      xAxis: { type: "value", show: false, scale: true },
      yAxis: { type: "value", show: false, scale: true },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        { type: "inside", yAxisIndex: 0, filterMode: "none" },
      ],
      series,
    };
  });

  const tagBubbles = $derived.by(() => {
    const max = Math.max(1, ...result.tagmap.map((t) => t.n));
    return [...result.tagmap]
      .sort((a, b) => b.n - a.n)
      .map((t) => {
        const k = Math.sqrt(t.n / max);
        return {
          name: t.tag,
          n: t.n,
          value: [t.x, t.y],
          symbolSize: 10 + 46 * k,
          label: { fontSize: Math.round(11 + 5 * k), fontWeight: k > 0.5 ? 600 : 500, color: isDark() ? "#f0efec" : "#0b0b0b" },
        };
      });
  });

  const tagMap = $derived(
    result.tagmap.length
      ? {
          tooltip: { formatter: (p: any) => `#${esc(p.data.name)}: <b>${p.data.n}</b>` },
          grid: { left: 32, right: 32, top: 32, bottom: 32 }, // room for the bubbles at the edges
          xAxis: { type: "value", show: false, scale: true },
          yAxis: { type: "value", show: false, scale: true },
          // A bubble per tag sized by its count, the tag in the middle; the larger tags come first, so a label
          // that would overlap one of them is hidden.
          series: [
            {
              type: "scatter",
              data: tagBubbles,
              // Translucency in the color, not in opacity: labels inherit opacity and would fade too.
              itemStyle: { color: hexAlpha(isDark() ? PALETTE.dark[0] : PALETTE.light[0], 0.2) },
              emphasis: { itemStyle: { color: hexAlpha(isDark() ? PALETTE.dark[0] : PALETTE.light[0], 0.4) } },
              label: { show: true, formatter: "{b}", position: "inside", textBorderWidth: 0 },
              labelLayout: { hideOverlap: true },
            },
          ],
        }
      : null,
  );

  const stats = $derived.by(() => {
    const cum = (v: number[]) => v.map(((sum) => (x: number) => +(sum += x).toFixed(4))(0));
    const n = Math.max(result.pca.text.length, result.pca.image.length);
    return {
      alignment: histogram(result.alignment.hist, s.anAlignment),
      similarity: {
        legend: { top: 0 },
        tooltip: { trigger: "axis" },
        xAxis: { type: "value", min: -0.2, max: 1 },
        yAxis: { type: "value" },
        series: (["text", "image"] as const).map((k) => ({
          name: k === "text" ? s.anSpaceText : s.anSpaceImage,
          type: "line",
          showSymbol: false,
          lineStyle: { width: 2 },
          data: result.similarity[k].counts.map((c, i) => [(result.similarity[k].edges[i] + result.similarity[k].edges[i + 1]) / 2, c]),
        })),
      },
      pca: {
        legend: { top: 0 },
        tooltip: { trigger: "axis", valueFormatter: (v: number) => `${(v * 100).toFixed(1)}%` },
        xAxis: { type: "category", data: Array.from({ length: n }, (_, i) => String(i + 1)), boundaryGap: false },
        yAxis: { type: "value", max: 1, axisLabel: { formatter: (v: number) => `${v * 100}%` } },
        series: (["text", "image"] as const).map((k) => ({
          name: k === "text" ? s.anSpaceText : s.anSpaceImage,
          type: "line",
          showSymbol: false,
          lineStyle: { width: 2 },
          data: cum(result.pca[k]),
        })),
      },
    };
  });

  /** Share of each large cluster in the memes saved per month (stacked to 100%). */
  const trend = $derived.by(() => {
    const t = result.trends;
    if (!t || t.months.length < 2 || !t.clusters.length) return null;
    const palette = isDark() ? PALETTE.dark : PALETTE.light;
    const share = (v: number[]) => v.map((n, m) => (t.total[m] ? n / t.total[m] : 0));
    const series = [...t.clusters.map((v, c) => ({ v, c })), { v: t.other, c: -1 }].map(({ v, c }) => {
      const cl = result.clusters[c];
      return {
        name: cl ? `${c + 1}. ${clusterName(cl)}` : s.anOther,
        type: "line",
        stack: "share",
        showSymbol: false,
        lineStyle: { width: 0 },
        areaStyle: { opacity: 0.85 },
        color: cl ? palette[c % palette.length] : OTHER,
        emphasis: { focus: "series" },
        data: share(v),
      };
    });
    return {
      legend: { top: 0, type: "scroll" },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => `${Math.round(v * 100)}%` },
      xAxis: { type: "category", data: t.months, boundaryGap: false },
      yAxis: { type: "value", max: 1, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } },
      series,
    };
  });
  const named = (ids: number[]) => ids.flatMap((c) => (result.clusters[c] ? [result.clusters[c]] : []));

  const duplicates = $derived((result.duplicates ?? []).filter(([a, b]) => !removed.includes(a) && !removed.includes(b)));

  async function remove(id: string) {
    if (!(await confirm(s.deleteConfirm))) return;
    await api.remove(id);
    removed = [...removed, id];
  }

  const spaceOptions = [
    { value: "text", label: s.anSpaceText },
    { value: "image", label: s.anSpaceImage },
  ];
  const viewOptions = [
    { value: "2d", label: s.an2d },
    { value: "3d", label: s.an3d },
  ];
  const colorOptions = [
    { value: "cluster", label: s.anByCluster },
    { value: "kind", label: s.anByKind },
    { value: "lang", label: s.anByLang },
    { value: "date", label: s.anByDate },
  ];
</script>

<Stack gap="md">
      <section class="card">
        <Stack gap="sm">
          <Inline gap="sm" align="center" wrap>
            <Heading as="h3" size="sm">{s.anMap}</Heading>
            <span class="spacer"></span>
            {#if has3d}<Select bind:value={view} options={viewOptions} aria-label={s.an3d} size="sm" />{/if}
            <Select bind:value={space} options={spaceOptions} aria-label={s.anSpace} size="sm" />
            <Select bind:value={color} options={colorOptions} aria-label={s.anColor} size="sm" />
          </Inline>
          <span class="hint">{view === "3d" && has3d ? s.an3dHint : s.anMapHint}</span>
          {#if view === "3d" && has3d}
            <Scatter3D
              points={result[space].xyz!}
              ids={result[space].ids}
              colors={coloring.colors}
              groups={coloring.group}
              label={s.anMap}
              {preview}
              onclick={onOpen}
            />
            {#if coloring.legend.length}
              <Inline gap="sm" wrap>
                {#each coloring.legend as l (l.name)}<span class="key"><i style:background={l.color}></i>{l.name}</span>{/each}
              </Inline>
            {/if}
          {:else}
            <Chart option={map} height="min(70vh, 640px)" label={s.anMap} onclick={(p) => p.data?.id && onOpen(p.data.id)} />
          {/if}
        </Stack>
      </section>

      {#if trend}
        <section class="card">
          <Stack gap="sm">
            <Heading as="h3" size="sm">{s.anTrends}</Heading>
            <span class="hint">{s.anTrendsHint}</span>
            <Chart option={trend} height="320px" label={s.anTrends} />
            {#each [[s.anRising, result.trends.rising], [s.anFading, result.trends.fading]] as const as [title, ids] (title)}
              {#if ids.length}
                <Inline gap="xs" align="center" wrap>
                  <strong>{title}:</strong>
                  {#each named(ids) as c (c.id)}<Tag>{c.id + 1}. {clusterName(c)}</Tag>{/each}
                </Inline>
              {/if}
            {/each}
          </Stack>
        </section>
      {/if}

      {#if result.clusters.length}
        <section>
          <Heading as="h3" size="sm">{s.anClusters}</Heading>
          <div class="clusters">
            {#each result.clusters as c (c.id)}
              <article class="card">
                <Stack gap="xs">
                  <strong>{clusterName(c)}</strong>
                  <span class="hint">{fill(s.anClusterN, { n: c.size })}{c.summary ? ` · ${c.summary}` : ""}</span>
                  <Inline gap="xs" wrap>
                    {#each c.tags.slice(0, 6) as t (t)}
                      <button class="tag" onclick={() => onTag(t)}><Tag>#{t}</Tag></button>
                    {/each}
                  </Inline>
                  <Thumbs ids={c.sample.slice(0, 6).filter((id) => !removed.includes(id))} {onOpen} />
                </Stack>
              </article>
            {/each}
          </div>
        </section>
      {/if}

      <div class="grid">
        {#if tagMap}
          <section class="card wide">
            <Heading as="h3" size="sm">{s.anTagMap}</Heading>
            <Chart option={tagMap} height="480px" label={s.anTagMap} onclick={(p) => p.data?.name && onTag(p.data.name)} />
          </section>
        {/if}
        <section class="card">
          <Heading as="h3" size="sm">{s.anAlignment}</Heading>
          <Chart option={stats.alignment} height="240px" label={s.anAlignment} />
        </section>
        <section class="card">
          <Heading as="h3" size="sm">{s.anSimilarity}</Heading>
          <Chart option={stats.similarity} height="240px" label={s.anSimilarity} />
        </section>
        <section class="card">
          <Heading as="h3" size="sm">{s.anPca}</Heading>
          <Chart option={stats.pca} height="240px" label={s.anPca} />
        </section>
      </div>

      <section class="card">
        <Heading as="h3" size="sm" class="card-title">{s.anDuplicates}</Heading>
        {#if !duplicates.length}
          <span class="hint">{s.anNoDuplicates}</span>
        {:else}
          <div class="pairs">
            {#each duplicates.slice(0, 60) as [a, b, sim] (a + b)}
              <div class="pair">
                <Thumbs ids={[a, b].filter((id) => !removed.includes(id))} {onOpen} />
                <Inline gap="xs" align="center">
                  <span class="hint">{fill(s.anSimilar, { sim: sim.toFixed(3) })}</span>
                  <Button size="sm" variant="ghost" onclick={() => remove(b)}>
                    {#snippet leading()}<Trash2 size={14} aria-hidden="true" />{/snippet}
                    {s.delete}
                  </Button>
                </Inline>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <section class="card">
        <Heading as="h3" size="sm">{s.anWorstAligned}</Heading>
        <Thumbs ids={result.alignment.worst.slice(0, 18).map(([id]) => id).filter((id) => !removed.includes(id))} {onOpen} />
      </section>

      <section class="card">
        <Heading as="h3" size="sm">{s.anOutliers}</Heading>
        <Thumbs ids={result.outliers.slice(0, 30).filter((id) => !removed.includes(id))} {onOpen} />
      </section>
</Stack>

<style>
  .card > :global(.card-title) {
    margin: 0 0 var(--cf-space-3);
  }
  .card {
    border: 1px solid var(--cf-color-border);
    border-radius: var(--cf-radius-lg);
    padding: var(--cf-space-3);
    min-width: 0;
  }
  .hint {
    color: var(--cf-color-text-muted);
    font-size: var(--cf-font-size-sm);
  }
  .spacer {
    flex: 1;
  }
  .grid,
  .clusters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
    gap: var(--cf-space-4);
  }
  .clusters {
    margin-top: var(--cf-space-2);
  }
  .wide {
    grid-column: 1 / -1;
  }
  .pairs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--cf-space-3);
  }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--cf-font-size-sm);
  }
  .key i {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }
  .tag {
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
</style>
