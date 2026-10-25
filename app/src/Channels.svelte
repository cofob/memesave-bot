<script lang="ts">
  import { Button, Heading, Inline, Stack, Switch, Text, Textarea } from "@cofob2/design-system-svelte";
  import { api, type Channel } from "./api";
  import { s } from "./strings";
  import { openTab } from "./telegram";

  let channels = $state<Channel[]>([]);
  let addUrl = $state("");
  let saved = $state<number | null>(null);

  const load = async () => ({ channels, addUrl } = await api.channels());
  load().catch(() => {});

  const save = async (ch: Channel) => {
    await api.setChannel(ch.chat_id, { caption: ch.caption });
    saved = ch.chat_id;
  };
</script>

<Heading as="h3" size="sm">{s.channelsTitle}</Heading>
<Text tone="muted" size="sm">{s.channelsHint}</Text>
{#each channels as ch (ch.chat_id)}
  <Stack gap="xs">
    <Switch
      label={`${ch.title ?? ch.chat_id}${ch.username ? ` · @${ch.username}` : ""}`}
      description={s.channelsPosting}
      checked={!!ch.enabled}
      onCheckedChange={(on) => api.setChannel(ch.chat_id, { enabled: on }).then(load)}
    />
    <Textarea label={s.channelsCaption} description={s.channelsCaptionHint} rows={2} bind:value={ch.caption} oninput={() => (saved = null)} />
    <Inline gap="sm" wrap>
      <Button size="sm" variant="secondary" onclick={() => save(ch)}>{saved === ch.chat_id ? s.stateReady : s.channelsSave}</Button>
      <Button size="sm" variant="ghost" onclick={() => api.removeChannel(ch.chat_id).then(load)}>{s.channelsUnlink}</Button>
    </Inline>
  </Stack>
{/each}
{#if addUrl}
  <Inline gap="sm"><Button size="sm" onclick={() => openTab(addUrl)}>{s.channelsAdd}</Button></Inline>
{/if}
