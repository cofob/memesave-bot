<script lang="ts" module>
  import { BarChart, HeatmapChart, LineChart, RadarChart, ScatterChart, TreemapChart } from "echarts/charts";
  import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
  import { init, use, type ECharts, type EChartsCoreOption } from "echarts/core";
  import { LabelLayout } from "echarts/features";
  import { CanvasRenderer } from "echarts/renderers";

  import { isDark, PALETTE } from "./charts";

  use([BarChart, HeatmapChart, LineChart, RadarChart, ScatterChart, TreemapChart, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent, CanvasRenderer, LabelLayout]); // LabelLayout: hideOverlap of labels
</script>

<script lang="ts">
  interface Props {
    option: EChartsCoreOption;
    height?: string;
    label: string;
    onclick?: (params: any) => void;
  }
  let { option, height = "280px", label, onclick }: Props = $props();

  let el = $state<HTMLDivElement>();
  let chart = $state.raw<ECharts>();
  let dark = $state(isDark());

  $effect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => (dark = isDark());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  });

  $effect(() => {
    if (!el) return;
    const c = init(el, dark ? "dark" : undefined);
    const resize = new ResizeObserver(() => c.resize());
    resize.observe(el);
    chart = c;
    return () => {
      resize.disconnect();
      c.dispose();
    };
  });

  $effect(() => {
    if (!chart) return;
    const ink = dark ? "#c3c2b7" : "#52514e";
    chart.setOption(
      {
        backgroundColor: "transparent",
        color: dark ? PALETTE.dark : PALETTE.light,
        textStyle: { fontFamily: "inherit", color: ink },
        grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
        ...option,
        // Merged, not replaced: every tooltip stays inside the chart (no overflow off a phone screen).
        tooltip: { ...((option as { tooltip?: object }).tooltip ?? {}), confine: true },
      },
      true,
    );
  });

  $effect(() => {
    if (!chart || !onclick) return;
    const handler = (p: any) => onclick(p);
    chart.on("click", handler);
    return () => chart?.off("click", handler);
  });
</script>

<div bind:this={el} class="chart" style:height role="img" aria-label={label}></div>

<style>
  .chart {
    width: 100%;
  }
</style>
