<script lang="ts">
  import { Button, Dialog, Drawer, Heading, IconButton, Inline, Spinner, Stack, Tag, Text, VideoPlayer } from "@cofob2/design-system-svelte";
  import { Check, ChevronLeft, ChevronRight, Clapperboard, FileDown, Layers, Link, Music, RefreshCw, Send, Share2, Trash2, VolumeX } from "@lucide/svelte";
  import { onMount, untrack } from "svelte";
  import { api, type MemeBrief, type MemeDetail } from "./api";
  import { s } from "./strings";
  import { confirm, saveFile, tg } from "./telegram";
  import { viewing } from "./viewing.svelte";

  interface Props {
    id: string;
    owner?: number; // a partner's meme opened outside the partner view (pair stats)
    onClose: () => void;
    onTag: (tag: string) => void;
    onDeleted: (id: string) => void;
    onRetried: (id: string) => void;
  }
  let { id: initial, owner, onClose, onTag, onDeleted, onRetried }: Props = $props();

  let id = $state(untrack(() => initial)); // the shown meme: album thumbnails switch it
  let meme = $state<MemeDetail | null>(null);
  $effect(() => {
    const want = id;
    api.get(want, owner).then((m) => want === id && (meme = m), () => (failed = true));
  });

  // Desktop: a wide dialog with the media next to the details; phones: a tall bottom sheet.
  const query = matchMedia("(min-width: 900px)");
  let wide = $state(query.matches);
  $effect(() => {
    const update = () => (wide = query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  });
  const kindLabel = $derived(meme ? (meme.kind === "photo" ? s.f_kind_photo : meme.kind === "video" ? s.video : s.gif) : "");
  const title = $derived(meme?.title ?? kindLabel);
  let busy = $state<"share" | "link" | "fileLink" | "send" | "album" | "clip" | "clipFile" | "sound" | "delete" | "retry" | null>(null);
  let soundInput = $state<HTMLInputElement>();
  let copied = $state<"link" | "fileLink" | null>(null);
  let failed = $state(false);
  const own = !viewing.who && !untrack(() => owner); // a partner's meme: only sending it to the chat

  const sections = $derived(
    meme
      ? [
          [s.text, meme.ocr_text],
          [s.speech, meme.speech_text],
          [s.description, meme.description],
          [s.context, meme.meme_context],
          [s.meaning, meme.cultural_meaning],
          [s.source, meme.source],
          [s.savedAt, meme.saved_at && new Date(meme.saved_at * 1000).toLocaleString()],
        ].filter(([, value]) => value)
      : [],
  );

  async function run(action: NonNullable<typeof busy>, fn: () => Promise<void>) {
    busy = action;
    try {
      await fn();
      tg?.HapticFeedback?.notificationOccurred("success");
    } catch {
      tg?.HapticFeedback?.notificationOccurred("error");
      tg?.showAlert(s.error);
    } finally {
      busy = null;
    }
  }

  const share = () =>
    run("share", async () => {
      if (!tg?.isVersionAtLeast("8.0")) return send();
      const { id: prepared } = await api.share(id);
      tg.shareMessage(prepared);
    });

  // The first copy makes the meme public: /s/<id> page and /d/<id>.<ext> file.
  const copyLink = (kind: "link" | "fileLink") =>
    run(kind, async () => {
      const { page, file } = await api.link(id);
      await navigator.clipboard.writeText(kind === "link" ? page : (file ?? page));
      copied = kind;
      setTimeout(() => copied === kind && (copied = null), 2000);
    });

  const send = () =>
    run("send", async () => {
      await api.send(id);
      tg?.showAlert(s.sent);
    });

  const sendAlbum = () =>
    run("album", async () => {
      await api.sendAlbum(id);
      tg?.showAlert(s.sent);
    });

  const sendClip = () =>
    run("clip", async () => {
      await api.sendClip(id);
      tg?.showAlert(s.sent);
    });

  // The video is made on the first request (may take a while), then kept.
  const downloadClip = () =>
    run("clipFile", async () => {
      const { url } = await api.clipLink(id);
      await saveFile(url, new URL(url).searchParams.get("dl") ?? "video.mp4");
    });

  // One sound per album: every photo of it shows the new one.
  const setSound = (file: File | null) =>
    run("sound", async () => {
      const { audio } = await api.setAudio(id, file);
      if (meme) meme.audio = audio;
    });

  const retry = () =>
    run("retry", async () => {
      await api.retry(id);
      onRetried(id);
    });

  const remove = async () => {
    if (!(await confirm(s.deleteConfirm))) return;
    await run("delete", async () => {
      await api.remove(id);
      onDeleted(id);
    });
  };

  // Album carousel: a swipe (or arrow) shows that meme; a thumbnail scrolls to it.
  let carousel = $state<HTMLElement>();
  let settle: ReturnType<typeof setTimeout>;
  const rtl = () => (carousel && getComputedStyle(carousel).direction === "rtl" ? -1 : 1);
  const index = () => (carousel ? Math.round(Math.abs(carousel.scrollLeft) / carousel.clientWidth) : 0);
  const step = (n: number) => carousel?.scrollBy({ left: n * carousel.clientWidth * rtl(), behavior: "smooth" });
  const onSwipe = () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const a = meme?.album[index()];
      if (a && a.id !== id) id = a.id;
    }, 120);
  };
  const at = $derived(meme?.album.findIndex((a) => a.id === id) ?? -1);
  $effect(() => {
    const j = at;
    if (carousel && j >= 0 && untrack(index) !== j) carousel.scrollTo({ left: j * carousel.clientWidth * untrack(rtl), behavior: "smooth" });
  });
  function onKey(e: KeyboardEvent) {
    const n = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!n || !carousel || (e.target as HTMLElement).closest("input, select, textarea, .cf-video-player")) return;
    e.preventDefault();
    step(n);
  }

  onMount(() => {
    tg?.BackButton.show();
    tg?.BackButton.onClick(onClose);
    return () => {
      tg?.BackButton.offClick(onClose);
      tg?.BackButton.hide();
    };
  });
</script>

<svelte:window onkeydown={onKey} />

<!-- full: the loaded detail of this meme, else (an album meme not shown yet) its thumbnail. -->
{#snippet one(full: MemeDetail | null, a: Pick<MemeBrief, "thumb" | "title">)}
  {#if full && full.kind !== "photo" && full.file}
    <VideoPlayer
      src={full.file}
      label={title}
      videoProps={{ poster: full.thumb, loop: full.kind === "animation", autoplay: full.kind === "animation", muted: full.kind === "animation", playsinline: true }}
    />
  {:else}
    <img src={full?.file ?? a.thumb} alt={a.title ?? title} />
  {/if}
{/snippet}

{#snippet media(m: MemeDetail)}
  <div class="stage">
    {#if m.album.length}
      <div class="carousel" bind:this={carousel} onscroll={onSwipe}>
        {#each m.album as a (a.id)}
          <div class="part">{@render one(a.id === m.id ? m : null, a)}</div>
        {/each}
      </div>
      <span class="nav prev"><IconButton label={s.feedPrev} variant="secondary" size="sm" disabled={at <= 0} onclick={() => step(-1)}><ChevronLeft size={18} /></IconButton></span>
      <span class="nav next"><IconButton label={s.feedNext} variant="secondary" size="sm" disabled={at >= m.album.length - 1} onclick={() => step(1)}><ChevronRight size={18} /></IconButton></span>
    {:else}
      {@render one(m, m)}
    {/if}
    {#if m.audio}<audio class="sound" src={m.audio} controls loop></audio>{/if}
  </div>
{/snippet}

{#snippet info(m: MemeDetail)}
  <Stack gap="md">
    {#if m.album.length}
      <div class="album">
        {#each m.album as a (a.id)}
          <button class="album-item" class:current={a.id === id} onclick={() => (id = a.id)} aria-label={a.title ?? a.id} aria-current={a.id === id}>
            <img src={a.thumb} alt="" loading="lazy" />
          </button>
        {/each}
      </div>
    {/if}
    {#if m.status !== "ready"}<Text tone="muted" size="sm">{m.status === "failed" ? s.stateError : s.processing}</Text>{/if}
    {#if m.tags.length}
      <Inline gap="xs" wrap>
        {#each m.tags as t (t)}
          <button class="tag-button" onclick={() => onTag(t)}><Tag>#{t}</Tag></button>
        {/each}
      </Inline>
    {/if}
    {#each sections as [label, value] (label)}
      <Stack gap="xs">
        <Heading as="h3" size="sm">{label}</Heading>
        <Text class="pre">{value}</Text>
      </Stack>
    {/each}
  </Stack>
{/snippet}

{#snippet body()}
  {#if failed}
    <Text tone="muted">{s.error}</Text>
  {:else if !meme}
    <div class="loading"><Spinner label="Loading" /></div>
  {:else if wide}
    <div class="split">
      {@render media(meme)}
      <div class="side">{@render info(meme)}</div>
    </div>
  {:else}
    <Stack gap="md">
      {@render media(meme)}
      {@render info(meme)}
    </Stack>
  {/if}
{/snippet}

{#snippet actions()}
  <Inline gap="sm" wrap>
    {#if meme?.status === "failed" && own}
      <Button onclick={retry} loading={busy === "retry"}>
        {#snippet leading()}<RefreshCw size={16} aria-hidden="true" />{/snippet}
        {s.retry}
      </Button>
    {/if}
    {#if tg && own}
      <Button onclick={share} loading={busy === "share"} disabled={!meme}>
        {#snippet leading()}<Share2 size={16} aria-hidden="true" />{/snippet}
        {s.share}
      </Button>
    {/if}
    {#if own}
      <Button variant="secondary" onclick={() => copyLink("link")} loading={busy === "link"} disabled={!meme}>
        {#snippet leading()}{#if copied === "link"}<Check size={16} aria-hidden="true" />{:else}<Link size={16} aria-hidden="true" />{/if}{/snippet}
        {copied === "link" ? s.copied : s.copyLink}
      </Button>
      {#if meme?.file}
        <Button variant="secondary" onclick={() => copyLink("fileLink")} loading={busy === "fileLink"}>
          {#snippet leading()}{#if copied === "fileLink"}<Check size={16} aria-hidden="true" />{:else}<FileDown size={16} aria-hidden="true" />{/if}{/snippet}
          {copied === "fileLink" ? s.copied : s.copyFileLink}
        </Button>
      {/if}
    {/if}
    <Button variant="secondary" onclick={send} loading={busy === "send"} disabled={!meme}>
      {#snippet leading()}<Send size={16} aria-hidden="true" />{/snippet}
      {s.send}
    </Button>
    {#if meme?.album.length && own}
      <Button variant="secondary" onclick={sendAlbum} loading={busy === "album"}>
        {#snippet leading()}<Layers size={16} aria-hidden="true" />{/snippet}
        {s.sendAlbum}
      </Button>
    {/if}
    {#if meme?.audio && own}
      <Button variant="secondary" onclick={sendClip} loading={busy === "clip"}>
        {#snippet leading()}<Clapperboard size={16} aria-hidden="true" />{/snippet}
        {s.sendClip}
      </Button>
      <Button variant="secondary" onclick={downloadClip} loading={busy === "clipFile"}>
        {#snippet leading()}<FileDown size={16} aria-hidden="true" />{/snippet}
        {s.downloadClip}
      </Button>
    {/if}
    {#if meme?.kind === "photo" && own}
      <input bind:this={soundInput} type="file" accept="audio/*" hidden onchange={(e) => e.currentTarget.files?.[0] && setSound(e.currentTarget.files[0])} />
      <Button variant="secondary" onclick={() => soundInput?.click()} loading={busy === "sound"}>
        {#snippet leading()}<Music size={16} aria-hidden="true" />{/snippet}
        {meme.audio ? s.replaceSound : s.addSound}
      </Button>
      {#if meme.audio}
        <Button variant="secondary" onclick={() => setSound(null)} disabled={busy === "sound"}>
          {#snippet leading()}<VolumeX size={16} aria-hidden="true" />{/snippet}
          {s.removeSound}
        </Button>
      {/if}
    {/if}
    {#if own}
      <Button variant="danger" onclick={remove} loading={busy === "delete"} disabled={!meme}>
        {#snippet leading()}<Trash2 size={16} aria-hidden="true" />{/snippet}
        {s.delete}
      </Button>
    {/if}
  </Inline>
{/snippet}

{#if wide}
  <Dialog open {title} closeLabel={s.close} class="viewer" onOpenChange={(open) => !open && onClose()}>
    {@render body()}
    {#snippet footer()}{@render actions()}{/snippet}
  </Dialog>
{:else}
  <Drawer open {title} side="bottom" closeLabel={s.close} class="viewer-sheet" onOpenChange={(open) => !open && onClose()}>
    {@render body()}
    {#snippet footer()}{@render actions()}{/snippet}
  </Drawer>
{/if}

<style>
  /* Desktop dialog: wide, media on a dark stage, details in a scrolling side column. */
  :global(.cf-dialog.viewer) {
    inline-size: min(calc(100% - 2rem), 76rem);
    max-block-size: calc(100dvh - 2rem);
  }
  :global(.cf-dialog.viewer .cf-dialog__body) {
    padding: 0;
  }
  /* A fixed row height: the side column scrolls and the media scales inside it. */
  .split {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(18rem, 2fr);
    grid-template-rows: minmax(0, 1fr);
    block-size: min(calc(100dvh - 12rem), 46rem);
  }
  .split .stage {
    position: relative;
    border-radius: 0;
    min-block-size: 0;
  }
  .split .stage img,
  .split .stage :global(.cf-video-player) {
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    max-block-size: none;
    object-fit: contain;
  }
  /* The player's frame has a fixed 16:9 ratio and its own border: here it fills the stage instead. */
  .split .stage :global(.cf-video-player) {
    grid-template-rows: minmax(0, 1fr);
  }
  .split .stage :global(.cf-video-player__frame) {
    aspect-ratio: auto;
    block-size: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .side {
    min-block-size: 0;
    overflow-y: auto;
    padding: var(--cf-space-5);
    border-inline-start: 1px solid var(--cf-color-border);
  }
  .stage {
    position: relative;
    display: grid;
    place-items: center;
    background: #09090b;
    border-radius: var(--cf-radius-lg);
    overflow: hidden;
    min-block-size: 12rem;
  }
  /* The sound of a photo: over the bottom of the stage. */
  .stage .sound {
    position: absolute;
    inset-inline: var(--cf-space-2, 0.5rem);
    inset-block-end: var(--cf-space-2, 0.5rem);
    inline-size: calc(100% - 2 * var(--cf-space-2, 0.5rem));
    z-index: 1;
  }
  .stage img,
  .stage :global(video) {
    max-inline-size: 100%;
    max-block-size: 100%;
    object-fit: contain;
  }
  /* Album: the memes in a horizontal swipe row. */
  .carousel {
    display: flex;
    inline-size: 100%;
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
    z-index: 1;
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
  /* Phones: a tall sheet; the image leaves room for the details. */
  :global(.cf-drawer.viewer-sheet[data-side="bottom"]) {
    block-size: 90dvh;
  }
  :global(.viewer-sheet) .stage {
    max-block-size: 50dvh;
  }
  :global(.viewer-sheet) .stage img {
    max-block-size: 50dvh;
  }
  .loading {
    display: grid;
    place-items: center;
    min-block-size: 12rem;
  }
  /* Album thumbnails: a scrolling row, the shown meme outlined. */
  .album {
    display: flex;
    gap: var(--cf-space-1-5);
    overflow-x: auto;
  }
  .album-item {
    all: unset;
    cursor: pointer;
    flex: none;
    inline-size: 3.5rem;
    aspect-ratio: 1;
    border-radius: var(--cf-radius-md);
    overflow: hidden;
  }
  .album-item img {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
  }
  .album-item.current {
    outline: 2px solid var(--cf-color-accent);
    outline-offset: -2px;
  }
  .tag-button {
    all: unset;
    cursor: pointer;
  }
  :global(.pre) {
    white-space: pre-wrap;
  }
</style>
