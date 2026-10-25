<script lang="ts">
  import { CircularProgress, IconButton, Spinner } from "@cofob2/design-system-svelte";
  import { Archive, ChevronDown, CircleAlert, CircleCheck, Clock, Film, Image, X } from "@lucide/svelte";
  import { fmt, s } from "./strings";
  import { clearFinished, uploads, type UploadState } from "./uploads.svelte";

  const busy = (state: UploadState) => state === "queued" || state === "uploading";
  const uploading = $derived(uploads.items.filter((i) => busy(i.state)).length);
  const processing = $derived(uploads.items.filter((i) => i.state === "processing").length);
  const title = $derived(
    uploading ? fmt(s.uploading, uploading) : fmt(s.uploadsDone, uploads.items.filter((i) => !busy(i.state)).length),
  );
  const stateLabel: Record<UploadState, string> = {
    queued: s.stateQueued,
    uploading: "",
    processing: s.stateProcessing,
    batched: s.stateBatched,
    ready: s.stateReady,
    duplicate: s.stateDuplicate,
    error: s.stateError,
  };
</script>

{#if uploads.open}
  <section class="panel" aria-label={title}>
    <header class="head">
      <div class="title">
        <strong>{title}</strong>
        {#if processing}<span class="sub">{fmt(s.processingN, processing)}</span>{/if}
      </div>
      <IconButton
        label={uploads.collapsed ? s.expand : s.collapse}
        variant="ghost"
        size="sm"
        onclick={() => (uploads.collapsed = !uploads.collapsed)}
      >
        <ChevronDown size={18} class={uploads.collapsed ? "flip" : ""} />
      </IconButton>
      {#if !uploading && !processing}
        <IconButton label={s.close} variant="ghost" size="sm" onclick={clearFinished}><X size={18} /></IconButton>
      {/if}
    </header>
    {#if !uploads.collapsed}
      <ul class="list">
        {#each uploads.items as item (item.key)}
          <li class="row" data-state={item.state}>
            <span class="icon">
              {#if item.kind === "zip"}<Archive size={18} />{:else if item.kind === "video"}<Film size={18} />{:else}<Image size={18} />{/if}
            </span>
            <span class="name" title={item.error ?? item.name}>{item.name}</span>
            <span class="state">
              {#if item.state === "uploading"}
                <CircularProgress value={Math.round(item.progress * 100)} label={item.name} size="sm" />
              {:else if item.state === "processing"}
                <span class="hint">{item.detail ?? stateLabel.processing}</span><Spinner size="sm" label={stateLabel.processing} />
              {:else if item.state === "batched"}
                <span class="hint">{stateLabel.batched}</span><Clock size={18} />
              {:else if item.state === "ready"}
                <CircleCheck size={20} class="ok" aria-label={stateLabel.ready} />
              {:else if item.state === "error"}
                <CircleAlert size={20} class="bad" aria-label={item.error ?? stateLabel.error} />
              {:else}
                <span class="hint">{stateLabel[item.state]}</span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .panel {
    position: fixed;
    inset-inline-end: var(--cf-space-4);
    inset-block-end: var(--cf-space-4);
    inline-size: min(360px, calc(100vw - 2 * var(--cf-space-4)));
    background: var(--cf-color-surface-raised);
    border: 1px solid var(--cf-color-border);
    border-radius: var(--cf-radius-lg);
    box-shadow: var(--cf-shadow-lg);
    overflow: hidden;
    z-index: var(--cf-z-toast);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--cf-space-1);
    padding: var(--cf-space-2) var(--cf-space-2) var(--cf-space-2) var(--cf-space-4);
    background: var(--cf-color-surface-muted);
  }
  .title {
    flex: 1;
    display: grid;
    min-inline-size: 0;
  }
  .sub,
  .hint {
    color: var(--cf-color-text-muted);
    font-size: var(--cf-font-size-xs);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: var(--cf-space-1) 0;
    max-block-size: 40vh;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--cf-space-3);
    padding: var(--cf-space-2) var(--cf-space-4);
  }
  .icon {
    display: grid;
    color: var(--cf-color-text-muted);
  }
  .name {
    flex: 1;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--cf-font-size-sm);
  }
  .state {
    display: flex;
    align-items: center;
    gap: var(--cf-space-2);
  }
  .state :global(.ok) {
    color: var(--cf-color-success);
  }
  .state :global(.bad) {
    color: var(--cf-color-danger);
  }
  .head :global(.flip) {
    transform: rotate(180deg);
  }
</style>
