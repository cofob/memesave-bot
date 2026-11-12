<script lang="ts">
  import { Badge, Button, EmptyState, IconButton, Select, Spinner } from "@cofob2/design-system-svelte";
  import { Info, Layers, RotateCcw, Send, Share2, Volume2, VolumeX, X } from "@lucide/svelte";
  import { onMount, untrack } from "svelte";
  import { api, type FeedItem, type FeedMode } from "./api";
  import MemeDetail from "./MemeDetail.svelte";
  import { fill, s } from "./strings";
  import { tg } from "./telegram";

  interface Props {
    initial?: FeedMode | null;
    onClose: () => void;
    onTag: (tag: string) => void;
    onDeleted: (id: string) => void;
  }
  let { initial, onClose, onTag, onDeleted }: Props = $props();

  const modes: { value: FeedMode; label: string }[] = [
    { value: "new", label: s.feedNew },
    { value: "old", label: s.feedOld },
    { value: "random", label: s.feedRandom },
    { value: "favorites", label: s.feedFavorites },
    { value: "forgotten", label: s.feedForgotten },
    { value: "day", label: s.feedDay },
    { value: "unseen", label: s.feedUnseen },
  ];
  const NEAR = 2; // slides around the active one that load full media

  // Per-device resume: the last mode, and per mode the seed and offset of the last shown meme.
  const load = <T,>(key: string): T | null => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  };
  const store = (key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };

  let mode = $state<FeedMode>(untrack(() => initial) ?? load<FeedMode>("feed:mode") ?? "new");
  let items = $state<FeedItem[]>([]);
  let next = $state<number | null>(0);
  let loading = $state(false);
  let failed = $state(false);
  let active = $state(0);
  let muted = $state(true);
  let paused = $state(false);
  let selected = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let scroller = $state<HTMLElement>();
  let seed = 1;
  let start = $state(0); // offset of items[0]
  let generation = 0; // drops answers for an older mode

  // seed: the order of "random"; for "unseen", the session start (memes seen in the session keep their place).
  const newSeed = (m: FeedMode) => (m === "random" ? 1 + Math.floor(Math.random() * 2147483646) : m === "unseen" ? Math.floor(Date.now() / 1000) : 1);

  function open(m: FeedMode, fresh = false) {
    flush();
    const saved = fresh ? null : load<{ seed: number; offset: number }>(`feed:${m}`);
    mode = m;
    store("feed:mode", m);
    seed = saved?.seed ?? newSeed(m);
    start = next = saved?.offset ?? 0;
    items = [];
    active = 0;
    failed = loading = false;
    generation++;
    scroller?.scrollTo({ top: 0 });
    more();
  }

  async function more() {
    if (loading || next === null) return;
    loading = true;
    const gen = generation;
    try {
      const page = await api.feed(mode, seed, next);
      if (gen !== generation) return;
      items = [...items, ...page.items];
      next = page.next_offset;
    } catch {
      if (gen === generation) failed = true;
    } finally {
      if (gen === generation) loading = false;
    }
  }

  // Seen: a meme shown for a second; sent in batches.
  const queue = new Set<string>();
  function flush() {
    if (!queue.size) return;
    const ids = [...queue];
    queue.clear();
    api.seen(ids).catch(() => {});
  }

  // The active slide: the one most visible in the viewport.
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && (active = Number((e.target as HTMLElement).dataset.i))),
    { threshold: 0.6 },
  );
  const watch = (node: HTMLElement) => {
    io.observe(node);
    return { destroy: () => io.unobserve(node) };
  };

  // Only the active video plays.
  const videos = new Map<number, HTMLVideoElement>();
  const sync = () => videos.forEach((v, i) => (i === active && !paused ? v.play().catch(() => {}) : v.pause()));
  const player = (node: HTMLVideoElement, i: number) => {
    videos.set(i, node);
    sync();
    return {
      update(n: number) {
        videos.delete(i);
        videos.set((i = n), node);
      },
      destroy: () => videos.delete(i),
    };
  };
  $effect(() => {
    active;
    paused;
    untrack(sync);
  });

  $effect(() => {
    const i = active;
    paused = false;
    return untrack(() => {
      if (i >= items.length - 3) more();
      const id = items[i]?.id;
      if (!id) return;
      store(`feed:${mode}`, { seed, offset: start + i });
      const timer = setTimeout(() => queue.add(id), 1000);
      return () => clearTimeout(timer);
    });
  });

  function closeDetail() {
    selected = null;
    setTimeout(() => tg?.BackButton.show()); // the detail hides it when it closes
  }
  const back = () => !selected && onClose();

  async function run(id: string, action: () => Promise<unknown>) {
    busy = id;
    try {
      await action();
      tg?.HapticFeedback?.notificationOccurred("success");
    } catch {
      tg?.HapticFeedback?.notificationOccurred("error");
    } finally {
      busy = null;
    }
  }
  const send = (id: string) => run(`send:${id}`, () => api.send(id));
  const share = (id: string) => run(`share:${id}`, async () => tg?.shareMessage((await api.share(id)).id));

  function onKey(e: KeyboardEvent) {
    if (selected || !scroller || (e.target as HTMLElement).closest("input, select, textarea")) return;
    if (e.key === "Escape") onClose();
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    scroller.scrollBy({ top: step * scroller.clientHeight, behavior: "smooth" });
  }

  const date = (t: number) => new Date(t * 1000).toLocaleDateString();

  onMount(() => {
    open(mode);
    const timer = setInterval(flush, 5000);
    const hidden = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", hidden);
    // Mini App: vertical swipes scroll the feed instead of closing the app.
    if (tg?.isVersionAtLeast("7.7")) tg.disableVerticalSwipes?.();
    tg?.BackButton.show();
    tg?.BackButton.onClick(back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hidden);
      flush();
      io.disconnect();
      if (tg?.isVersionAtLeast("7.7")) tg.enableVerticalSwipes?.();
      tg?.BackButton.offClick(back);
      tg?.BackButton.hide();
    };
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="feed">
  <div class="bar">
    <IconButton label={s.close} variant="ghost" size="sm" onclick={onClose}><X size={18} /></IconButton>
    <Select value={mode} options={modes} aria-label={s.feedMode} size="sm" onchange={(e: Event) => open((e.currentTarget as HTMLSelectElement).value as FeedMode)} />
    {#if start > 0}
      <IconButton label={s.feedStartOver} variant="ghost" size="sm" onclick={() => open(mode, true)}><RotateCcw size={16} /></IconButton>
    {/if}
  </div>

  <div class="slides" bind:this={scroller}>
    {#each items as it, i (it.id)}
      {@const near = Math.abs(i - active) <= NEAR}
      <section class="slide" data-i={i} use:watch>
        {#if near && it.file && it.kind !== "photo"}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            use:player={i}
            src={it.file}
            poster={it.thumb}
            loop
            playsinline
            preload={i === active ? "auto" : "metadata"}
            muted={muted || it.kind === "animation"}
            onclick={() => (paused = !paused)}
          ></video>
        {:else}
          <img src={near && it.kind === "photo" && it.file ? it.file : it.thumb} alt={it.title ?? ""} loading="lazy" />
        {/if}

        <div class="info">
          {#if it.title}<strong>{it.title}</strong>{/if}
          <span class="meta">
            {date(it.date)}{#if it.uses} · {fill(s.feedUses, { n: it.uses })}{/if}
            {#if it.album}<Badge size="sm" variant="solid"><Layers size={12} aria-hidden="true" /> {it.album}</Badge>{/if}
          </span>
          {#if !it.file && it.kind !== "photo"}<span class="meta">{s.feedTooBig}</span>{/if}
          {#if it.tags.length}<span class="tags">{it.tags.slice(0, 5).map((t) => `#${t}`).join(" ")}</span>{/if}
        </div>

        <div class="actions">
          {#if it.kind === "video" && it.file}
            <IconButton label={muted ? s.feedSoundOn : s.feedSoundOff} variant="secondary" onclick={() => (muted = !muted)}>
              {#if muted}<VolumeX size={20} />{:else}<Volume2 size={20} />{/if}
            </IconButton>
          {/if}
          <IconButton label={s.feedDetails} variant="secondary" onclick={() => (selected = it.id)}><Info size={20} /></IconButton>
          <IconButton label={s.send} variant="secondary" loading={busy === `send:${it.id}`} onclick={() => send(it.id)}><Send size={20} /></IconButton>
          {#if tg}
            <IconButton label={s.share} variant="secondary" loading={busy === `share:${it.id}`} onclick={() => share(it.id)}><Share2 size={20} /></IconButton>
          {/if}
        </div>
      </section>
    {/each}

    {#if loading && !items.length}
      <section class="slide end"><Spinner label="Loading" /></section>
    {:else if failed}
      <section class="slide end">
        <EmptyState title={s.error}>
          {#snippet action()}<Button size="sm" onclick={() => ((failed = false), more())}>{s.retry}</Button>{/snippet}
        </EmptyState>
      </section>
    {:else if next === null}
      <section class="slide end">
        <EmptyState title={items.length || start ? s.feedEnd : s.feedEmpty}>
          {#snippet action()}
            {#if items.length || start}<Button size="sm" onclick={() => open(mode, true)}>{s.feedStartOver}</Button>{/if}
            {#if mode !== "random"}<Button size="sm" variant="secondary" onclick={() => open("random", true)}>{s.feedRandom}</Button>{/if}
          {/snippet}
        </EmptyState>
      </section>
    {/if}
  </div>
</div>

{#if selected}
  <MemeDetail
    id={selected}
    onClose={closeDetail}
    onTag={(t) => {
      selected = null;
      onTag(t);
    }}
    onRetried={closeDetail}
    onDeleted={(id) => {
      items = items.filter((m) => m.id !== id);
      onDeleted(id);
      closeDetail();
    }}
  />
{/if}

<style>
  .feed {
    --feed-bg: #000;
    --feed-fg: #fff;
    position: fixed;
    inset: 0;
    z-index: calc(var(--cf-z-sticky) + 10);
    background: var(--feed-bg);
    color: var(--feed-fg);
  }
  .bar {
    position: absolute;
    inset-block-start: 0;
    inset-inline: 0;
    z-index: 1;
    display: flex;
    gap: var(--cf-space-2);
    align-items: center;
    padding: var(--cf-space-2) var(--cf-space-4);
    background: linear-gradient(rgb(0 0 0 / 0.55), transparent);
  }
  .bar :global(.cf-icon-button) {
    color: var(--feed-fg);
  }
  .slides {
    block-size: 100%;
    overflow-y: auto;
    scroll-snap-type: y mandatory;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }
  .slide {
    position: relative;
    block-size: 100%;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .slide img,
  .slide video {
    inline-size: 100%;
    block-size: 100%;
    max-block-size: none;
    object-fit: contain;
  }
  .end {
    color: var(--cf-color-text);
    background: var(--cf-color-canvas);
  }
  .info {
    position: absolute;
    inset-inline: 0 calc(var(--cf-space-4) + 56px);
    inset-block-end: 0;
    display: grid;
    gap: var(--cf-space-1);
    padding: var(--cf-space-8) var(--cf-space-4) max(var(--cf-space-4), env(safe-area-inset-bottom));
    background: linear-gradient(transparent, rgb(0 0 0 / 0.6));
    pointer-events: none;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    gap: var(--cf-space-2);
    align-items: center;
    flex-wrap: wrap;
    font-size: var(--cf-font-size-sm, 0.875rem);
    opacity: 0.85;
  }
  .tags {
    font-size: var(--cf-font-size-sm, 0.875rem);
    opacity: 0.85;
  }
  .actions {
    position: absolute;
    inset-inline-end: var(--cf-space-4);
    inset-block-end: max(var(--cf-space-6), env(safe-area-inset-bottom));
    display: grid;
    gap: var(--cf-space-3);
  }
</style>
