<script lang="ts">
  import { Badge, Button, EmptyState, IconButton, Select, Spinner, TextField } from "@cofob2/design-system-svelte";
  import { BookmarkPlus, Check, ChevronLeft, ChevronRight, Info, Layers, RotateCcw, Send, Share2, Volume2, VolumeX, X } from "@lucide/svelte";
  import { onMount, tick, untrack } from "svelte";
  import { api, ApiError, type FeedMode, type Owner, type PairFeedItem, type PairFeedMode } from "./api";
  import MemeDetail from "./MemeDetail.svelte";
  import { fill, locale, s } from "./strings";
  import { tg } from "./telegram";

  interface Props {
    initial?: FeedMode | PairFeedMode | null;
    pair?: { id: string; name: string; partner: number }; // the pair feed: both collections (partner: their user id)
    onClose: () => void;
    onTag: (tag: string) => void;
    onDeleted: (id: string) => void;
  }
  let { initial, pair, onClose, onTag, onDeleted }: Props = $props();
  type Mode = FeedMode | PairFeedMode;

  const modes: { value: FeedMode; label: string }[] = [
    { value: "new", label: s.feedNew },
    { value: "old", label: s.feedOld },
    { value: "random", label: s.feedRandom },
    { value: "favorites", label: s.feedFavorites },
    { value: "forgotten", label: s.feedForgotten },
    { value: "time", label: s.feedTime },
    { value: "unseen", label: s.feedUnseen },
  ];
  // The pair feed: the modes available now come with each page.
  const p = untrack(() => pair);
  const pairModes: Record<PairFeedMode, string> | undefined = p && {
    mix: s.feedMix,
    theirs: fill(s.pairTheirs, { name: p.name }),
    twins: s.pairNear,
    rhymes: s.pairRhymes,
    foryou: fill(s.pairForYou, { name: p.name }),
    surprise: fill(s.pairSurprise, { name: p.name }),
    bridge: s.pairBridge,
    guess: s.pairGuess,
  };
  const prefix = p ? `feed:pair:${p.id}:` : "feed:"; // localStorage keys
  const shuffle: Mode = p ? "mix" : "random";
  const NEAR = 2; // slides around the active one that load full media
  const DAY = 86400;
  // Points of the "time" mode, days back from now.
  const points = [
    { value: "30", label: s.feedMonthAgo },
    { value: "182", label: s.feedHalfYearAgo },
    { value: "365", label: s.feedYearAgo },
    { value: "730", label: s.feedTwoYearsAgo },
  ];

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

  const known = (m: string | null | undefined) => (m && (pairModes ? m in pairModes : modes.some((x) => x.value === m)) ? (m as Mode) : null);
  let mode = $state<Mode>(known(untrack(() => initial)) ?? known(load<string>(`${prefix}mode`)) ?? (p ? "mix" : "new"));
  let available = $state<PairFeedMode[]>([]);
  const options = $derived(pairModes ? (available.length ? available : [mode as PairFeedMode]).map((m) => ({ value: m, label: pairModes[m] })) : modes);
  let items = $state<PairFeedItem[]>([]);
  let next = $state<number | null>(0);
  let up = $state<number | null>(null); // "time" mode: offset of the next newer page, above items[0]
  let loading = $state(false);
  let loadingUp = false;
  let failed = $state(false);
  let active = $state(0);
  let muted = $state(true);
  let paused = $state(false);
  let selected = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let scroller = $state<HTMLElement>();
  let seed = $state(1);
  let start = $state(0); // offset of items[0]
  let generation = 0; // drops answers for an older mode
  let guessed = $state<Record<string, { correct: boolean; owner: Owner }>>({}); // "guess" answers by meme
  let score = $state([0, 0]); // right, total guesses of the session
  let taken = $state<Record<string, boolean>>({}); // partner memes copied to the own collection
  const whose = (it: PairFeedItem) => it.owner ?? guessed[it.id]?.owner;

  // seed: the order of "random"; for "unseen", the session start (memes seen in the session keep their place);
  // for "time", the point in time (a year ago by default).
  const now = () => Math.floor(Date.now() / 1000);
  const newSeed = (m: Mode) =>
    m === "random" || m === "mix" || m === "guess" ? 1 + Math.floor(Math.random() * 2147483646) : m === "unseen" || m === "theirs" ? now() : m === "time" ? now() - 365 * DAY : 1;

  /** Opens a mode where it was left (fresh: from the start; at: the "time" mode from this point). */
  function open(m: Mode, fresh = false, at?: number) {
    flush();
    const saved = fresh ? null : load<{ seed: number; offset: number }>(`${prefix}${m}`);
    mode = m;
    store(`${prefix}mode`, m);
    seed = at ?? saved?.seed ?? newSeed(m);
    start = next = m === "time" ? 0 : (saved?.offset ?? 0);
    up = m === "time" ? 0 : null;
    items = [];
    active = 0;
    failed = loading = loadingUp = false;
    generation++;
    scroller?.scrollTo({ top: 0 });
    more().then(newer); // newer after: their place above needs the page below
  }

  /** "time" mode: puts the next newer memes above the list, keeping the shown meme in place. */
  async function newer() {
    if (loadingUp || up === null) return;
    loadingUp = true;
    const gen = generation;
    try {
      const page = await api.feed(mode as FeedMode, seed, up, true);
      if (gen !== generation) return;
      const added = page.items.reverse();
      const top = scroller?.scrollTop ?? 0;
      items = [...added, ...items];
      active += added.length;
      up = page.next_offset;
      await tick();
      if (scroller) scroller.scrollTop = top + added.length * scroller.clientHeight;
    } catch {
      // the older side still works; scrolling up tries again
    } finally {
      if (gen === generation) loadingUp = false;
    }
  }

  async function more() {
    if (loading || next === null) return;
    loading = true;
    const gen = generation;
    try {
      const page = await (p ? api.pairFeed(p.id, mode as PairFeedMode, seed, next) : api.feed(mode as FeedMode, seed, next));
      if (gen !== generation) return;
      items = [...items, ...page.items];
      next = page.next_offset;
      if ("modes" in page) available = page.modes as PairFeedMode[];
    } catch (e) {
      // The pair feed: the mode is no longer available (the partner stopped sharing, the analysis expired).
      if (gen === generation && p && mode !== "mix" && e instanceof ApiError && e.status === 400) (loading = false), open("mix");
      else if (gen === generation) failed = true;
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
    (p ? api.pairFeedSeen(p.id, ids) : api.seen(ids)).catch(() => {});
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

  // Album slides: the shown one per meme id, from the horizontal scroll.
  let part = $state<Record<string, number>>({});
  const parts = (it: PairFeedItem) => it.slides ?? [it];
  const onSwipe = (id: string) => (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    part[id] = Math.round(Math.abs(el.scrollLeft) / el.clientWidth); // abs: scrollLeft is negative in RTL
  };
  const swipe = (step: number) => {
    const el = scroller?.querySelector<HTMLElement>(`[data-i="${active}"] .carousel`);
    el?.scrollBy({ left: step * el.clientWidth * (getComputedStyle(el).direction === "rtl" ? -1 : 1), behavior: "smooth" });
  };

  // Only the active video (or photo sound) plays: [meme id, album slide] (-1: the sound of the whole post).
  const players = new Map<HTMLMediaElement, [string, number]>();
  const sync = () => {
    const id = items[active]?.id;
    players.forEach(([i, j], v) => (i === id && (j < 0 || j === (part[i] ?? 0)) && !paused ? v.play().catch(() => {}) : v.pause()));
  };
  const player = (node: HTMLMediaElement, at: [string, number]) => {
    players.set(node, at);
    sync();
    return { update: (n: [string, number]) => players.set(node, n), destroy: () => players.delete(node) };
  };
  $effect(() => {
    active;
    paused;
    part[items[active]?.id];
    untrack(sync);
  });

  $effect(() => {
    const i = active;
    paused = false;
    return untrack(() => {
      if (i >= items.length - 3) more();
      if (i <= 2) newer();
      const id = items[i]?.id;
      if (!id) return;
      // "time" resumes at the date of the shown meme.
      store(`${prefix}${mode}`, mode === "time" ? { seed: items[i].date, offset: 0 } : { seed, offset: start + i });
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
  const take = (id: string) =>
    run(`take:${id}`, async () => {
      const r = await api.copyMeme(id);
      taken[id] = true;
      tg?.showAlert(r.duplicate ? s.feedHaveIt : s.feedTaken);
    });

  async function guess(id: string, owner: Owner) {
    if (busy) return;
    busy = `guess:${id}:${owner}`;
    try {
      const r = await api.pairGuess(p!.id, id, owner);
      guessed[id] = r;
      score = [score[0] + Number(r.correct), score[1] + 1];
      tg?.HapticFeedback?.notificationOccurred(r.correct ? "success" : "error");
    } catch {
      tg?.HapticFeedback?.notificationOccurred("error");
    } finally {
      busy = null;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (selected || !scroller || (e.target as HTMLElement).closest("input, select, textarea")) return;
    if (e.key === "Escape") onClose();
    const side = { ArrowRight: 1, l: 1, ArrowLeft: -1, h: -1 }[e.key];
    if (side) return e.preventDefault(), swipe(side);
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    scroller.scrollBy({ top: step * scroller.clientHeight, behavior: "smooth" });
  }

  // "12 October 2026 · last month": the full date and how long ago, in the user's locale.
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const date = (t: number) => {
    const days = (now() - t) / DAY;
    const [n, unit] = days < 30 ? [days, "day"] : days < 365 ? [days / 30.44, "month"] : [days / 365.25, "year"];
    const full = new Date(t * 1000).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
    return `${full} · ${rtf.format(-Math.round(n), unit as Intl.RelativeTimeFormatUnit)}`;
  };

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
    <IconButton label={s.close} variant="secondary" size="sm" onclick={onClose}><X size={18} /></IconButton>
    <Select value={mode} {options} aria-label={s.feedMode} size="sm" onchange={(e: Event) => open((e.currentTarget as HTMLSelectElement).value as Mode)} />
    {#if mode === "guess"}<Badge variant="solid">{fill(s.feedScore, { n: score[0], total: score[1] })}</Badge>{/if}
    {#if mode === "time"}
      <Select
        value=""
        placeholder={s.feedJump}
        options={points}
        aria-label={s.feedJump}
        size="sm"
        onchange={(e: Event) => open("time", true, now() - Number((e.currentTarget as HTMLSelectElement).value) * DAY)}
      />
      <TextField
        type="date"
        size="sm"
        aria-label={s.feedPickDate}
        value={new Date(seed * 1000).toLocaleDateString("sv")}
        max={new Date().toLocaleDateString("sv")}
        onchange={(e: Event) => {
          const value = (e.currentTarget as HTMLInputElement).value;
          if (value) open("time", true, Math.floor(new Date(`${value}T23:59:59`).getTime() / 1000));
        }}
      />
    {/if}
    {#if start > 0}
      <IconButton label={s.feedStartOver} variant="secondary" size="sm" onclick={() => open(mode, true)}><RotateCcw size={16} /></IconButton>
    {/if}
  </div>

  <div class="slides" bind:this={scroller}>
    {#each items as it, i (it.id)}
      {@const near = Math.abs(i - active) <= NEAR}
      {@const who = whose(it)}
      {@const answer = guessed[it.id]}
      {@const all = parts(it)}
      {@const cur = part[it.id] ?? 0}
      <section class="slide" data-i={i} use:watch style:--ar={Math.max(9 / 16, (it.width ?? 0) / (it.height || 1))}>
        <div class="carousel" onscroll={onSwipe(it.id)}>
          {#each all as m, j (m.id)}
            {@const soon = Math.abs(i - active) <= 1 && Math.abs(j - cur) <= 1}
            <div class="part">
              {#if near && m.file && m.kind !== "photo"}
                <!-- svelte-ignore a11y_media_has_caption -->
                <video
                  use:player={[it.id, j]}
                  src={m.file}
                  poster={m.thumb}
                  loop
                  playsinline
                  preload={soon ? "auto" : "metadata"}
                  muted={muted || m.kind === "animation" || !!it.audio}
                  onclick={() => (paused = !paused)}
                ></video>
              {:else}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                <img src={near && m.kind === "photo" && m.file ? m.file : m.thumb} alt={m.title ?? ""} loading="lazy" onclick={() => it.audio && (paused = !paused)} />
              {/if}
            </div>
          {/each}
        </div>
        {#if near && it.audio}<audio use:player={[it.id, -1]} src={it.audio} loop preload={Math.abs(i - active) <= 1 ? "auto" : "metadata"} {muted}></audio>{/if}
        {#if all.length > 1}
          <span class="nav prev"><IconButton label={s.feedPrev} variant="secondary" size="sm" disabled={cur === 0} onclick={() => i === active && swipe(-1)}><ChevronLeft size={18} /></IconButton></span>
          <span class="nav next"><IconButton label={s.feedNext} variant="secondary" size="sm" disabled={cur === all.length - 1} onclick={() => i === active && swipe(1)}><ChevronRight size={18} /></IconButton></span>
          <span class="dots" aria-hidden="true">{#each all as m, j (m.id)}<i class:on={j === cur}></i>{/each}</span>
        {/if}

        <div class="info">
          {#if it.title}<strong>{it.title}</strong>{/if}
          <span class="meta">
            {date(it.date)}{#if it.uses} · {fill(s.feedUses, { n: it.uses })}{/if}
            {#if it.album}<Badge size="sm" variant="solid"><Layers size={12} aria-hidden="true" /> {(part[it.id] ?? 0) + 1}/{it.album}</Badge>{/if}
            {#if p && who}
              <Badge size="sm" variant="solid" tone={answer ? (answer.correct ? "success" : "danger") : who === "me" ? "accent" : "info"}>
                {#if answer}{answer.correct ? s.feedRight : s.feedWrong} · {/if}{who === "me" ? s.feedMine : p.name}
              </Badge>
            {/if}
          </span>
          {#if parts(it).some((m) => !m.file && m.kind !== "photo")}<span class="meta">{s.feedTooBig}</span>{/if}
          {#if it.tags.length}
            <span class="tags">
              {#each it.tags.slice(0, 5) as t (t)}<button onclick={() => onTag(t)}>#{t}</button>{/each}
            </span>
          {/if}
          {#if p && !who}
            <span class="guess">
              {#each ["me", "partner"] as const as o (o)}
                <Button size="lg" loading={busy === `guess:${it.id}:${o}`} onclick={() => guess(it.id, o)}>{o === "me" ? s.feedMine : fill(s.feedTheirs, { name: p.name })}</Button>
              {/each}
            </span>
          {/if}
        </div>

        <div class="actions">
          {#if parts(it).some((m) => m.kind === "video" && m.file) || it.audio}
            <IconButton label={muted ? s.feedSoundOn : s.feedSoundOff} variant="secondary" onclick={() => (muted = !muted)}>
              {#if muted}<VolumeX size={20} />{:else}<Volume2 size={20} />{/if}
            </IconButton>
          {/if}
          {#if !p || who}
            <IconButton label={s.feedDetails} variant="secondary" onclick={() => (selected = it.id)}><Info size={20} /></IconButton>
            <IconButton label={s.send} variant="secondary" loading={busy === `send:${it.id}`} onclick={() => send(it.id)}><Send size={20} /></IconButton>
          {/if}
          {#if who === "partner"}
            <IconButton label={s.feedTake} variant="secondary" loading={busy === `take:${it.id}`} disabled={taken[it.id]} onclick={() => take(it.id)}>
              {#if taken[it.id]}<Check size={20} />{:else}<BookmarkPlus size={20} />{/if}
            </IconButton>
          {:else if tg && (!p || who)}
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
            {#if mode !== shuffle}<Button size="sm" variant="secondary" onclick={() => open(shuffle, true)}>{p ? s.feedMix : s.feedRandom}</Button>{/if}
          {/snippet}
        </EmptyState>
      </section>
    {/if}
  </div>
</div>

{#if selected}
  {@const it = items.find((m) => m.id === selected)}
  <MemeDetail
    id={selected}
    owner={it && whose(it) === "partner" ? p?.partner : undefined}
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
    flex-wrap: wrap;
    gap: var(--cf-space-2);
    align-items: center;
    padding: var(--cf-space-2) var(--cf-space-4);
    background: linear-gradient(rgb(0 0 0 / 0.55), transparent);
  }
  .bar :global(.cf-icon-button),
  .actions :global(.cf-icon-button) {
    color: var(--cf-color-text); /* not the white text of the feed */
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
  .carousel {
    display: flex;
    inline-size: 100%;
    max-inline-size: calc(100dvh * var(--ar, 9 / 16)); /* fit the media on wide screens; the info stays at the screen edges */
    block-size: 100%;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .part {
    position: relative;
    flex: 0 0 100%;
    display: grid;
    place-items: center;
    scroll-snap-align: start;
    scroll-snap-stop: always;
  }
  .nav {
    position: absolute;
    inset-block-start: 50%;
    translate: 0 -50%;
  }
  .nav :global(.cf-icon-button) {
    color: var(--cf-color-text);
  }
  .prev {
    inset-inline-start: var(--cf-space-2);
  }
  .next {
    inset-inline-end: var(--cf-space-2);
  }
  @media (pointer: coarse) {
    .nav {
      display: none; /* touch: swipe */
    }
  }
  .dots {
    position: absolute;
    inset-block-start: calc(var(--cf-space-2) * 2 + 40px); /* under the bar */
    inset-inline: 0;
    display: flex;
    justify-content: center;
    gap: 4px;
    pointer-events: none;
  }
  .dots i {
    inline-size: 6px;
    block-size: 6px;
    border-radius: 50%;
    background: var(--feed-fg);
    opacity: 0.4;
  }
  .dots i.on {
    opacity: 1;
  }
  .slide img,
  .slide video {
    position: absolute; /* fits the slide, never grows it */
    inset: 0;
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
    inset-inline: 0;
    inset-block-end: 0;
    display: grid;
    gap: var(--cf-space-1);
    padding: var(--cf-space-8) var(--cf-space-4) max(var(--cf-space-4), env(safe-area-inset-bottom));
    padding-inline-end: calc(var(--cf-space-4) * 2 + 56px); /* room for the action buttons */
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
    display: flex;
    flex-wrap: wrap;
    gap: var(--cf-space-1) var(--cf-space-2);
    font-size: var(--cf-font-size-sm, 0.875rem);
  }
  .tags button {
    all: unset;
    cursor: pointer;
    pointer-events: auto; /* the info block lets taps through to the video */
    opacity: 0.85;
  }
  .tags button:hover,
  .tags button:focus-visible {
    opacity: 1;
    text-decoration: underline;
  }
  .guess {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--cf-space-2);
    pointer-events: auto;
  }
  .actions {
    position: absolute;
    inset-inline-end: var(--cf-space-4);
    inset-block-end: max(var(--cf-space-6), env(safe-area-inset-bottom));
    display: grid;
    gap: var(--cf-space-3);
  }
</style>
