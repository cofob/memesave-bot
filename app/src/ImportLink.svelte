<script lang="ts">
  import { Alert, Button, Dialog, Stack, Text, TextField } from "@cofob2/design-system-svelte";
  import { api, ApiError } from "./api";
  import { s } from "./strings";

  let { open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: () => void } = $props();
  let url = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function start() {
    const link = url.trim();
    if (!/^https?:\/\/\S+$/i.test(link)) return (error = s.importBadUrl);
    busy = true;
    error = null;
    try {
      await api.importUrl(link);
      url = "";
      onStarted();
      onClose();
    } catch (e) {
      error = e instanceof ApiError && e.status === 402 ? null : s.error; // 402: the page shows the billing hint
      if (!error) onClose();
    } finally {
      busy = false;
    }
  }
</script>

<Dialog {open} title={s.importLink} closeLabel={s.close} onOpenChange={(o) => !o && onClose()}>
  <Stack gap="md">
    <Text>{s.importHint}</Text>
    <TextField type="url" bind:value={url} placeholder="https://" aria-label={s.importLink} onkeydown={(e) => e.key === "Enter" && start()} />
    {#if error}<Alert tone="danger" title={error} />{/if}
  </Stack>
  {#snippet footer()}
    <Button loading={busy} onclick={start}>{s.importStart}</Button>
  {/snippet}
</Dialog>
