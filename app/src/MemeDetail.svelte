<script lang="ts">
  import { Button, Dialog, Drawer, Heading, Inline, Spinner, Stack, Tag, Text, VideoPlayer } from "@cofob2/design-system-svelte";
  import { Layers, RefreshCw, Send, Share2, Trash2 } from "@lucide/svelte";
  import { onMount, untrack } from "svelte";
  import { api, type MemeDetail } from "./api";
  import { s } from "./strings";
  import { confirm, tg } from "./telegram";

  interface Props {
    id: string;
    onClose: () => void;
    onTag: (tag: string) => void;
    onDeleted: (id: string) => void;
    onRetried: (id: string) => void;
  }
  let { id: initial, onClose, onTag, onDeleted, onRetried }: Props = $props();

  let id = $state(untrack(() => initial)); // the shown meme: album thumbnails switch it
  let meme = $state<MemeDetail | null>(null);
  $effect(() => {
    const want = id;
    api.get(want).then((m) => want === id && (meme = m), () => (failed = true));
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
  let busy = $state<"share" | "send" | "album" | "delete" | "retry" | null>(null);
  let failed = $state(false);

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

  onMount(() => {
    tg?.BackButton.show();
    tg?.BackButton.onClick(onClose);
    return () => {
      tg?.BackButton.offClick(onClose);
      tg?.BackButton.hide();
    };
  });
</script>

{#snippet media(m: MemeDetail)}
  <div class="stage">
    {#if m.kind !== "photo" && m.file}
      <VideoPlayer
        src={m.file}
        label={title}
        videoProps={{ poster: m.thumb, loop: m.kind === "animation", autoplay: m.kind === "animation", muted: m.kind === "animation", playsinline: true }}
      />
    {:else}
      <img src={m.file ?? m.thumb} alt={title} />
    {/if}
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
    {#if meme?.status === "failed"}
      <Button onclick={retry} loading={busy === "retry"}>
        {#snippet leading()}<RefreshCw size={16} aria-hidden="true" />{/snippet}
        {s.retry}
      </Button>
    {/if}
    {#if tg}
      <Button onclick={share} loading={busy === "share"} disabled={!meme}>
        {#snippet leading()}<Share2 size={16} aria-hidden="true" />{/snippet}
        {s.share}
      </Button>
    {/if}
    <Button variant="secondary" onclick={send} loading={busy === "send"} disabled={!meme}>
      {#snippet leading()}<Send size={16} aria-hidden="true" />{/snippet}
      {s.send}
    </Button>
    {#if meme?.album.length}
      <Button variant="secondary" onclick={sendAlbum} loading={busy === "album"}>
        {#snippet leading()}<Layers size={16} aria-hidden="true" />{/snippet}
        {s.sendAlbum}
      </Button>
    {/if}
    <Button variant="danger" onclick={remove} loading={busy === "delete"} disabled={!meme}>
      {#snippet leading()}<Trash2 size={16} aria-hidden="true" />{/snippet}
      {s.delete}
    </Button>
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
  .side {
    min-block-size: 0;
    overflow-y: auto;
    padding: var(--cf-space-5);
    border-inline-start: 1px solid var(--cf-color-border);
  }
  .stage {
    display: grid;
    place-items: center;
    background: #09090b;
    border-radius: var(--cf-radius-lg);
    overflow: hidden;
    min-block-size: 12rem;
  }
  .stage img,
  .stage :global(video) {
    max-inline-size: 100%;
    max-block-size: 100%;
    object-fit: contain;
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
