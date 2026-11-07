<script lang="ts">
  // Interactive 3D point cloud on a 2D canvas: drag (mouse or touch) rotates, the wheel zooms, hover shows the
  // meme preview, a click opens it. Points are sorted by depth each frame; nearer points are larger and stronger.
  import { onDestroy } from "svelte";
  import { esc } from "./charts";

  interface Props {
    points: [number, number, number][];
    ids: string[];
    colors: string[];
    groups: string[];
    label: string;
    preview: (id: string, extra?: string) => string;
    onclick: (id: string) => void;
  }
  let { points, ids, colors, groups, label, preview, onclick }: Props = $props();

  let wrap = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();
  let tip = $state<{ x: number; y: number; html: string } | null>(null);
  let yaw = 0.6;
  let pitch = 0.35;
  let zoom = 1;
  let spinning = true; // turns slowly until the first interaction
  let frame = 0;
  let projected: { x: number; y: number; r: number }[] = [];

  // Centered and scaled to radius 1.
  const unit = $derived.by(() => {
    const c = [0, 1, 2].map((d) => points.reduce((a, p) => a + p[d], 0) / Math.max(1, points.length));
    const r = Math.max(1e-9, ...points.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
    return points.map((p) => p.map((v, d) => (v - c[d]) / r) as [number, number, number]);
  });

  function draw() {
    if (!canvas || !wrap) return;
    const dpr = devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
    const scale = (Math.min(w, h) / 2.4) * zoom;
    const base = Math.max(1.6, Math.min(4, 260 / Math.sqrt(unit.length)));
    const depth = new Float32Array(unit.length);
    projected = unit.map(([x, y, z], i) => {
      const x1 = cy * x + sy * z;
      const z1 = -sy * x + cy * z;
      const y2 = cp * y - sp * z1;
      const z2 = sp * y + cp * z1;
      const persp = 3 / (3 + z2); // camera at distance 3
      depth[i] = z2;
      return { x: w / 2 + x1 * scale * persp, y: h / 2 - y2 * scale * persp, r: base * persp };
    });
    const order = Array.from(unit.keys()).sort((a, b) => depth[b] - depth[a]); // far first
    for (const i of order) {
      const p = projected[i];
      ctx.globalAlpha = 0.45 + 0.45 * (1 - (depth[i] + 1) / 2);
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function loop() {
    if (spinning) yaw += 0.003;
    draw();
    frame = spinning ? requestAnimationFrame(loop) : 0;
  }
  const redraw = () => (frame ||= requestAnimationFrame(() => ((frame = 0), draw())));

  $effect(() => {
    void [unit, colors];
    redraw();
  });
  $effect(() => {
    if (!wrap) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(wrap);
    frame = requestAnimationFrame(loop);
    return () => ro.disconnect();
  });
  onDestroy(() => cancelAnimationFrame(frame));

  /** The point under the pointer (within its radius plus 6 px), the nearest one on screen. */
  function hit(x: number, y: number) {
    let best = -1;
    let bestD = Infinity;
    projected.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < p.r + 6 && d < bestD) [best, bestD] = [i, d];
    });
    return best;
  }

  let drag: { x: number; y: number; moved: boolean } | null = null;
  function down(e: PointerEvent) {
    spinning = false;
    drag = { x: e.clientX, y: e.clientY, moved: false };
    canvas?.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    const rect = canvas!.getBoundingClientRect();
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      yaw += dx * 0.008;
      pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * 0.008));
      drag.x = e.clientX;
      drag.y = e.clientY;
      tip = null;
      redraw();
      return;
    }
    const i = hit(e.clientX - rect.left, e.clientY - rect.top);
    tip = i < 0 ? null : { x: e.clientX - rect.left, y: e.clientY - rect.top, html: preview(ids[i], `<br><small>${esc(groups[i])}</small>`) };
  }
  function up(e: PointerEvent) {
    const rect = canvas!.getBoundingClientRect();
    if (drag && !drag.moved) {
      const i = hit(e.clientX - rect.left, e.clientY - rect.top);
      if (i >= 0) onclick(ids[i]);
    }
    drag = null;
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    spinning = false;
    zoom = Math.max(0.5, Math.min(8, zoom * Math.exp(-e.deltaY * 0.0015)));
    redraw();
  }
</script>

<div bind:this={wrap} class="wrap">
  <canvas
    bind:this={canvas}
    aria-label={label}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointerleave={() => (tip = null)}
    onwheel={wheel}
  ></canvas>
  {#if tip}
    <div class="tip" style:left="{Math.min(tip.x + 14, (wrap?.clientWidth ?? 0) - 170)}px" style:top="{tip.y + 14}px">{@html tip.html}</div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    height: min(70vh, 640px);
    overflow: hidden;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
    cursor: grab;
    touch-action: none;
  }
  canvas:active {
    cursor: grabbing;
  }
  .tip {
    position: absolute;
    pointer-events: none;
    padding: 6px;
    border-radius: var(--cf-radius-md);
    background: var(--cf-color-surface-raised);
    border: 1px solid var(--cf-color-border);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.15);
    font-size: var(--cf-font-size-sm);
    z-index: 1;
  }
</style>
