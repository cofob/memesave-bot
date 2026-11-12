<script lang="ts">
  // A grid of meme previews from the loaded search index; a click opens the meme. `note` adds a line under each.
  import type { MemeBrief } from "./api";
  import { blurId, nsfw } from "./nsfw.svelte";
  import { indexed, loadIndex, textIndex } from "./search.svelte";

  interface Props {
    ids: string[];
    onOpen: (id: string) => void;
    note?: (id: string) => string;
    items?: Map<string, MemeBrief>; // memes outside the own index (a partner's)
  }
  let { ids, onOpen, note, items }: Props = $props();

  $effect(() => {
    if (!textIndex.version && ids.length) loadIndex().catch(() => {});
  });
</script>

<div class="thumbs">
  {#each ids as id (id)}
    {@const m = items?.get(id) ?? (textIndex.version >= 0 ? indexed(id) : undefined)}
    <figure>
      <button class="thumb" onclick={() => onOpen(id)} aria-label={m?.title ?? id} use:nsfw={m ? blurId(m) : false}>
        {#if m}<img src={m.thumb} alt={m.title ?? ""} loading="lazy" />{/if}
      </button>
      {#if note}<figcaption>{note(id)}</figcaption>{/if}
    </figure>
  {/each}
</div>

<style>
  .thumbs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
    gap: var(--cf-space-1);
  }
  figure {
    margin: 0;
    min-width: 0;
  }
  figcaption {
    font-size: var(--cf-font-size-xs);
    color: var(--cf-color-text-muted);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thumb {
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    border: 0;
    border-radius: var(--cf-radius-sm);
    overflow: hidden;
    background: var(--cf-color-surface-muted);
    cursor: pointer;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
</style>
