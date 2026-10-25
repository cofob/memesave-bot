<script lang="ts">
  import { Button, Heading, Inline, Stack, Switch, Text, TextField } from "@cofob2/design-system-svelte";
  import { api, type ApiToken, type Connection } from "./api";
  import { fill, s } from "./strings";

  let items = $state<Connection[]>([]);
  let mcpUrl = $state("");
  let copied = $state(false);

  const load = async () => ({ items, mcp_url: mcpUrl } = await api.connections());
  load().catch(() => {});

  const copy = async () => {
    await navigator.clipboard.writeText(mcpUrl);
    copied = true;
  };
  const date = (t: number) => new Date(t * 1000).toLocaleDateString();

  let tokens = $state<ApiToken[]>([]);
  let tokenName = $state("");
  let tokenWrite = $state(false);
  let newToken = $state("");
  const loadTokens = async () => (tokens = await api.tokens());
  loadTokens().catch(() => {});
  const create = async () => {
    newToken = (await api.createToken(tokenName, tokenWrite)).token;
    tokenName = "";
    await loadTokens();
  };
</script>

<Heading as="h3" size="sm">{s.connTitle}</Heading>
<Text tone="muted" size="sm">{s.connHint}</Text>
{#if mcpUrl}
  <Inline gap="sm" wrap>
    <TextField label={s.connUrl} value={mcpUrl} readonly size="sm" />
    <Button size="sm" variant="secondary" onclick={copy}>{copied ? s.connCopied : s.connCopy}</Button>
  </Inline>
  <Stack gap="xs">
    {#each s.connSteps as step}
      <Text size="sm">{fill(step, { url: mcpUrl })}</Text>
    {/each}
  </Stack>
{/if}
{#each items as c (c.id)}
  <Stack gap="xs">
    <Text>{c.client}{c.domain ? ` · ${c.domain}` : ""}</Text>
    <Text tone="muted" size="sm">{c.scope.includes("memes:write") ? s.connReadWrite : s.connRead} · {date(c.created_at)}</Text>
    <Inline gap="sm"><Button size="sm" variant="ghost" onclick={() => api.revokeConnection(c.id).then(load)}>{s.connRevoke}</Button></Inline>
  </Stack>
{/each}

<Heading as="h3" size="sm">{s.tokensTitle}</Heading>
<Text tone="muted" size="sm">{fill(s.tokensHint, { url: `${location.origin}/app/api/` })}</Text>
<Inline gap="sm" wrap>
  <TextField label={s.tokensName} bind:value={tokenName} size="sm" />
  <Button size="sm" variant="secondary" onclick={create}>{s.tokensCreate}</Button>
</Inline>
<Switch label={s.tokensWrite} bind:checked={tokenWrite} />
{#if newToken}
  <TextField label={s.tokensNew} value={newToken} readonly size="sm" />
{/if}
{#each tokens as tk (tk.id)}
  <Stack gap="xs">
    <Text>{tk.name}</Text>
    <Text tone="muted" size="sm">
      {tk.write ? s.connReadWrite : s.connRead} · {date(tk.created_at)}{tk.used_at ? ` · ${fill(s.tokensUsed, { date: date(tk.used_at) })}` : ""}
    </Text>
    <Inline gap="sm"><Button size="sm" variant="ghost" onclick={() => api.deleteToken(tk.id).then(loadTokens)}>{s.tokensDelete}</Button></Inline>
  </Stack>
{/each}
