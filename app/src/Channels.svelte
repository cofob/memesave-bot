<script lang="ts">
  import { Button, Checkbox, Heading, Inline, Select, Stack, Switch, Text, TextField, Textarea } from "@cofob2/design-system-svelte";
  import { api, type Channel } from "./api";
  import { s } from "./strings";
  import { openTab } from "./telegram";

  let channels = $state<Channel[]>([]);
  let addUrl = $state("");
  let saved = $state<number | null>(null);

  const load = async () => ({ channels, addUrl } = await api.channels());
  load().catch(() => {});

  const KINDS = ["photo", "video", "animation"] as const;
  // Tags are edited as comma-separated text and split on save.
  let tags = $state<Record<number, { in: string; out: string }>>({});
  $effect(() => {
    for (const ch of channels) tags[ch.chat_id] ??= { in: ch.tags_in.join(", "), out: ch.tags_out.join(", ") };
  });
  const split = (s = "") => s.split(",").map((x) => x.trim()).filter(Boolean);
  const toggleKind = (ch: Channel, k: Channel["kinds"][number], on: boolean) => {
    ch.kinds = on ? [...ch.kinds, k] : ch.kinds.filter((x) => x !== k);
    saved = null;
  };

  const save = async (ch: Channel) => {
    const { caption, porn, kinds, comics } = ch;
    await api.setChannel(ch.chat_id, { caption, porn, kinds, comics, tags_in: split(tags[ch.chat_id]?.in), tags_out: split(tags[ch.chat_id]?.out) });
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
    <Switch
      label={s.channelsStorage}
      description={s.channelsStorageHint}
      checked={!!ch.storage}
      onCheckedChange={(on) => api.setChannel(ch.chat_id, { storage: on }).then(load)}
    />
    <Textarea label={s.channelsCaption} description={s.channelsCaptionHint} rows={2} bind:value={ch.caption} oninput={() => (saved = null)} />
    <Select
      label={s.channelsPorn}
      bind:value={ch.porn}
      onchange={() => (saved = null)}
      options={[
        { value: "all", label: s.channelsPornAll },
        { value: "only", label: s.channelsPornOnly },
        { value: "none", label: s.channelsPornNone },
      ]}
    />
    <Text size="sm">{s.channelsKinds}</Text>
    <Inline gap="sm" wrap>
      {#each KINDS as k (k)}
        <Checkbox label={s[`channelsKind_${k}`]} checked={ch.kinds.includes(k)} onchange={(e) => toggleKind(ch, k, e.currentTarget.checked)} />
      {/each}
    </Inline>
    {#if tags[ch.chat_id]}
      <TextField label={s.channelsTagsIn} description={s.channelsTagsHint} bind:value={tags[ch.chat_id].in} oninput={() => (saved = null)} size="sm" />
      <TextField label={s.channelsTagsOut} bind:value={tags[ch.chat_id].out} oninput={() => (saved = null)} size="sm" />
    {/if}
    <Select
      label={s.channelsComics}
      bind:value={ch.comics}
      onchange={() => (saved = null)}
      options={[
        { value: "off", label: s.channelsComicsOff },
        { value: "media", label: s.channelsComicsMedia },
        { value: "link", label: s.channelsComicsLink },
      ]}
    />
    <Inline gap="sm" wrap>
      <Button size="sm" variant="secondary" onclick={() => save(ch)}>{saved === ch.chat_id ? s.stateReady : s.channelsSave}</Button>
      <Button size="sm" variant="ghost" onclick={() => api.removeChannel(ch.chat_id).then(load)}>{s.channelsUnlink}</Button>
    </Inline>
  </Stack>
{/each}
{#if addUrl}
  <Inline gap="sm"><Button size="sm" onclick={() => openTab(addUrl)}>{s.channelsAdd}</Button></Inline>
{/if}
