<script lang="ts" module>
  export const clusterName = (c: { name?: string; tags: string[] }) => c.name ?? c.tags.slice(0, 3).join(", ");
</script>

<script lang="ts">
  // The joint meme map of a pair: points by whose they are (me / partner / twins), large clusters labeled.
  import { Heading, Inline, Select, Stack } from "@cofob2/design-system-svelte";
  import type { MemeBrief, PairResult } from "./api";
  import Chart from "./Chart.svelte";
  import { esc, isDark, PALETTE } from "./charts";
  import Scatter3D from "./Scatter3D.svelte";
  import { s } from "./strings";

  interface Props {
    result: PairResult;
    side: number; // the viewer's owner index
    names: [me: string, partner: string];
    brief: (id: string) => MemeBrief | undefined;
    onOpen: (id: string) => void;
  }
  let { result, side, names, brief, onOpen }: Props = $props();

  let view = $state<"2d" | "3d">("2d");
  const m = $derived(result.map);
  const has3d = $derived(!!m.xyz?.length);
  const groups = $derived([...names, s.pairTwins]);

  const coloring = $derived.by(() => {
    const palette = isDark() ? PALETTE.dark : PALETTE.light;
    const twins = new Set(result.twins.flatMap(([a, b]) => [a, b]));
    const group = m.ids.map((id, i) => (twins.has(id) ? 2 : m.owner[i] === side ? 0 : 1));
    return { group, colors: group.map((g) => palette[g]), legend: groups.map((name, g) => ({ name, color: palette[g] })) };
  });
  const clusterOf = (i: number) => result.clusters.find((c) => c.id === m.labels?.[i]);

  function preview(id: string, extra = "") {
    const b = brief(id);
    const img = b ? `<img src="${esc(b.thumb)}" alt="" style="display:block;width:140px;height:140px;object-fit:cover;border-radius:6px;margin-bottom:4px">` : "";
    return `${img}<div style="max-width:140px;white-space:normal">${esc(b?.title ?? id)}${extra}</div>`;
  }
  const extra = (i: number) => {
    const c = clusterOf(i);
    return `<br><small>${esc(groups[coloring.group[i]])}${c ? ` · ${esc(clusterName(c))}` : ""}</small>`;
  };

  const chart = $derived({
    legend: { top: 0, data: groups },
    tooltip: { trigger: "item", formatter: (p: any) => p.data?.id && preview(p.data.id, extra(p.data.i)) },
    grid: { left: 8, right: 8, top: 32, bottom: 8 },
    xAxis: { type: "value", show: false, scale: true },
    yAxis: { type: "value", show: false, scale: true },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "inside", yAxisIndex: 0, filterMode: "none" },
    ],
    series: [
      ...coloring.legend.map(({ name, color }, g) => ({
        type: "scatter",
        name,
        symbolSize: g === 2 ? 8 : 5,
        emphasis: { scale: 2 },
        itemStyle: { color, opacity: 0.8 },
        data: m.ids.flatMap((id, i) => (coloring.group[i] === g ? [{ value: m.xy[i], id, i }] : [])),
      })),
      {
        // Cluster names at their centers; the larger clusters come first and win overlaps.
        type: "scatter",
        silent: true,
        symbolSize: 0,
        tooltip: { show: false },
        data: result.clusters.slice(0, 12).map((c) => ({ value: [c.x, c.y], name: clusterName(c) })),
        label: { show: true, formatter: "{b}", fontWeight: 600, color: isDark() ? "#f0efec" : "#0b0b0b", textBorderColor: isDark() ? "#1a1a19" : "#fcfcfb", textBorderWidth: 3 },
        labelLayout: { hideOverlap: true },
      },
    ],
  });

  const viewOptions = [
    { value: "2d", label: s.an2d },
    { value: "3d", label: s.an3d },
  ];
</script>

<section class="card">
  <Stack gap="sm">
    <Inline gap="sm" align="center" wrap>
      <Heading as="h4" size="sm">{s.pairMap}</Heading>
      <span class="spacer"></span>
      {#if has3d}<Select bind:value={view} options={viewOptions} aria-label={s.an3d} size="sm" />{/if}
    </Inline>
    <span class="hint">{view === "3d" && has3d ? s.an3dHint : s.anMapHint}</span>
    {#if view === "3d" && has3d}
      <Scatter3D points={m.xyz!} ids={m.ids} colors={coloring.colors} groups={coloring.group.map((g) => groups[g])} label={s.pairMap} {preview} onclick={onOpen} />
      <Inline gap="sm" wrap>
        {#each coloring.legend as l (l.name)}<span class="key"><i style:background={l.color}></i>{l.name}</span>{/each}
      </Inline>
    {:else}
      <Chart option={chart} height="min(70vh, 640px)" label={s.pairMap} onclick={(p) => p.data?.id && onOpen(p.data.id)} />
    {/if}
  </Stack>
</section>

<style>
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
</style>
