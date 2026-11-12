<script lang="ts">
  // A public analysis link (/?analysis=<sid>): the results read-only, no login.
  import { Container, EmptyState, Spinner, Stack } from "@cofob2/design-system-svelte";
  import { api, type SharedAnalysis } from "./api";
  import { s } from "./strings";

  const sid = new URLSearchParams(location.search).get("analysis") ?? "";
  let data = $state.raw<SharedAnalysis | null>(null);
  let missing = $state(false);
  api.sharedAnalysis(sid).then((v) => (data = v), () => (missing = true));
  const none = () => {};
</script>

<Container size="default" class="app">
  <Stack gap="lg">
    {#if missing}
      <EmptyState title={s.anSharedMissing} />
    {:else if !data}
      <Spinner label="Loading" />
    {:else if data.kind === "pair"}
      {#await import("./PairStats.svelte") then { default: PairStats }}
        <PairStats id="" shared={data} onOpen={none} onView={none} onFeed={none} />
      {/await}
    {:else}
      {#await import("./Analytics.svelte") then { default: Analytics }}
        <Analytics shared={data.result} />
      {/await}
    {/if}
    <p class="hint"><a href="/bot">{s.anSharedFooter}</a></p>
  </Stack>
</Container>

<style>
  .hint {
    color: var(--cf-color-text-muted, #71717a);
    font-size: var(--cf-font-size-sm, 0.875rem);
  }
</style>
