<script lang="ts">
  import { Badge, IconButton } from "@cofob2/design-system-svelte";
  import { X } from "@lucide/svelte";
  import { onMount } from "svelte";
  import type { FeedMedia } from "./api";
  import { blurId, nsfw } from "./nsfw.svelte";
  import { s } from "./strings";
  import { tg } from "./telegram";

  interface Props {
    pages: FeedMedia[];
    title: string;
    onClose: () => void;
  }
  let { pages, title, onClose }: Props = $props();

  let page = $state(1);
  let loaded = $state<Record<string, boolean>>({});
  let gif = $state<Record<string, boolean>>({}); // an animation the video element cannot play (a GIF file): shown as an image

  // A modal dialog stays above other dialogs (the meme detail); Escape closes it.
  const modal = (node: HTMLDialogElement) => node.showModal();
  const cancel = (e: Event) => (e.preventDefault(), onClose());

  // The page at the middle of the screen is the current one; one observer for all pages.
  let io: IntersectionObserver | undefined;
  const watch = (node: HTMLElement) => {
    io ??= new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (page = Number((e.target as HTMLElement).dataset.n))), {
      root: node.closest("dialog"),
      rootMargin: "-50% 0px -50% 0px",
    });
    io.observe(node);
    return { destroy: () => io?.unobserve(node) };
  };

  // Only pages near the current one have media (videos only next to it); others keep their size.
  const NEAR = 5;
  let ratio = $state<Record<string, number>>({}); // width / height measured on load, when the meme has no size
  const ar = (m: FeedMedia) => (m.width && m.height ? m.width / m.height : ratio[m.id]);
  const measure = (id: string, w: number, h: number) => w && h && !ratio[id] && (ratio[id] = w / h);

  onMount(() => {
    tg?.BackButton.show();
    tg?.BackButton.onClick(onClose);
    return () => {
      tg?.BackButton.offClick(onClose);
      tg?.BackButton.hide();
    };
  });
</script>

<dialog use:modal oncancel={cancel} aria-label={title}>
  <div class="bar">
    <IconButton label={s.close} variant="secondary" size="sm" onclick={onClose}><X size={18} /></IconButton>
    <Badge variant="solid">{page} / {pages.length}</Badge>
  </div>
  <div class="pages">
    {#each pages as m, i (m.id)}
      {@const d = Math.abs(i + 1 - page)}
      <div class="page" data-n={i + 1} use:watch use:nsfw={blurId(m)} style:aspect-ratio={d <= NEAR ? ar(m) : (ar(m) ?? 3 / 4)}>
        {#if d > NEAR}
          <!-- a placeholder -->
        {:else if m.kind !== "photo" && m.file && !m.gif && !gif[m.id] && d <= 1}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={m.file} poster={m.thumb} playsinline loop={m.kind === "animation"} muted={m.kind === "animation"} autoplay={m.kind === "animation"} controls={m.kind === "video"} preload="metadata" onerror={() => (gif[m.id] = true)} onloadedmetadata={(e) => measure(m.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}></video>
        {:else}
          <img src={m.kind === "photo" || m.gif || gif[m.id] ? (m.file ?? m.thumb) : m.thumb} alt={m.title ?? ""} loading="lazy" decoding="async" class:loaded={loaded[m.id] || !!ar(m)} onload={(e) => ((loaded[m.id] = true), measure(m.id, (e.currentTarget as HTMLImageElement).naturalWidth, (e.currentTarget as HTMLImageElement).naturalHeight))} />
        {/if}
      </div>
    {/each}
  </div>
</dialog>

<style>
  dialog {
    position: fixed;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    max-inline-size: none;
    max-block-size: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: #000;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .bar {
    position: fixed;
    inset-block-start: 0;
    inset-inline: 0;
    z-index: 1;
    display: flex;
    gap: var(--cf-space-2);
    align-items: center;
    padding: var(--cf-space-2) var(--cf-space-4);
    background: linear-gradient(rgb(0 0 0 / 0.55), transparent);
    pointer-events: none;
  }
  .bar > :global(*) {
    pointer-events: auto;
  }
  .bar :global(.cf-icon-button) {
    color: var(--cf-color-text); /* not the white text of the page */
  }
  .pages {
    display: grid;
    justify-items: center;
  }
  .page {
    inline-size: 100%;
    max-inline-size: 800px;
  }
  img,
  video {
    display: block;
    inline-size: 100%;
    block-size: auto;
  }
  img:not(.loaded) {
    min-block-size: 40dvh; /* room for lazy loading until the size is known */
  }
</style>
