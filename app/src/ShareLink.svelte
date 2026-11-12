<script lang="ts">
  // Copy / revoke the public link of the finished analysis (of the user, or of `pair`).
  import { Button, Checkbox, Inline } from "@cofob2/design-system-svelte";
  import { Check, Link, Unlink } from "@lucide/svelte";
  import { api } from "./api";
  import { s } from "./strings";

  // porn: there is porn stats to share (a different choice makes a new link).
  let { pair, porn = false, link = $bindable() }: { pair?: string; porn?: boolean; link?: string | null } = $props();
  let normal = $state(true);
  let withPorn = $state(false);
  let busy = $state(false);
  let copied = $state(false);

  async function act(f: () => Promise<void>) {
    busy = true;
    try {
      await f();
    } finally {
      busy = false;
    }
  }
  const copy = () =>
    act(async () => {
      link = (await api.analysisShare(pair, { normal, porn: porn && withPorn })).url;
      await navigator.clipboard.writeText(link);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    });
  const revoke = () =>
    act(async () => {
      await api.analysisUnshare(pair);
      link = null;
    });
</script>

<section class="card">
  <Inline gap="sm" align="center" wrap>
    <Checkbox bind:checked={normal} label={s.anShareNormal} />
    {#if porn}<Checkbox bind:checked={withPorn} label={s.anSharePorn} />{/if}
    <Button size="sm" variant="secondary" onclick={copy} loading={busy} disabled={!normal && !(porn && withPorn)}>
      {#snippet leading()}{#if copied}<Check size={16} aria-hidden="true" />{:else}<Link size={16} aria-hidden="true" />{/if}{/snippet}
      {copied ? s.copied : s.anShare}
    </Button>
    {#if link}
      <Button size="sm" variant="ghost" onclick={revoke} disabled={busy}>
        {#snippet leading()}<Unlink size={16} aria-hidden="true" />{/snippet}
        {s.anUnshare}
      </Button>
    {/if}
    <span class="hint">{s.anShareHint}</span>
  </Inline>
</section>

<style>
  .card {
    border: 1px solid var(--cf-color-border, rgb(127 127 127 / 0.25));
    border-radius: var(--cf-radius-lg, 12px);
    padding: var(--cf-space-3, 0.75rem);
  }
  .hint {
    color: var(--cf-color-text-muted, #71717a);
    font-size: var(--cf-font-size-sm, 0.875rem);
  }
</style>
