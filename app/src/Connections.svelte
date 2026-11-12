<script lang="ts">
  import { Alert, Button, Heading, Inline, Progress, Select, Stack, Switch, Text, TextField } from "@cofob2/design-system-svelte";
  import { onDestroy } from "svelte";
  import { api, ApiError, type ApiToken, type Connection, type E621Lists, type E621Status } from "./api";
  import { fill, s } from "./strings";
  import { onLive } from "./live";

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

  let e621 = $state<E621Status>({ connected: false });
  let e621User = $state("");
  let e621Key = $state("");
  let e621Msg = $state("");
  const loadE621 = async () => (e621 = await api.e621());
  loadE621().catch(() => {});
  onDestroy(onLive((e) => void ((e.t === "reconnect" || (e.t === "job" && e.kind === "e621")) && loadE621().catch(() => {})))); // each sync step
  const connectE621 = async () => {
    e621Msg = "";
    try {
      await api.connectE621(e621User.trim(), e621Key.trim());
      e621Key = "";
      await loadE621();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 402)) e621Msg = e instanceof ApiError && e.status === 400 ? s.e621Invalid : s.e621Failed;
    }
  };
  const e621Act = (call: () => Promise<unknown>) => call().then(loadE621).catch(() => {});
  const e621Error: Record<string, string> = { unauthorized: s.e621Err_unauthorized, "payment required": s.e621Err_payment_required, "storage full": s.e621Err_storage_full };
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

<Heading as="h3" size="sm">{s.e621Title}</Heading>
<Text tone="muted" size="sm">{s.e621Hint}</Text>
{#if e621.connected}
  <Text size="sm">{fill(e621.backfill_done ? s.e621Synced : s.e621Importing, { user: e621.username ?? "", n: String(e621.imported ?? 0) })}</Text>
  {#if !e621.backfill_done && e621.fav}
    <Progress value={Math.round((100 * e621.fav.done) / e621.fav.total)} label={fill(s.e621FavProgress, e621.fav)} animated showValue />
  {/if}
  {#if e621.error}<Alert tone="danger" title={e621Error[e621.error] ?? e621.error} />{/if}
  {#if e621.last_sync}<Text tone="muted" size="sm">{fill(s.e621Last, { date: new Date(e621.last_sync * 1000).toLocaleString() })}</Text>{/if}
  <Select
    label={s.e621Lists}
    value={e621.lists}
    options={[
      { value: "fav", label: s.e621ListFav },
      { value: "up", label: s.e621ListUp },
      { value: "both", label: s.e621ListBoth },
    ]}
    onchange={(e: Event) => e621Act(() => api.setE621Lists((e.currentTarget as HTMLSelectElement).value as E621Lists))}
  />
  <Switch label={s.e621Pools} description={s.e621PoolsHint} checked={!!e621.pools} onCheckedChange={(on) => e621Act(() => api.setE621Pools(on))} />
  <Inline gap="sm">
    <Button size="sm" variant="secondary" disabled={!e621.backfill_done} onclick={() => e621Act(api.syncE621)}>{s.e621Sync}</Button>
    <Button size="sm" variant="ghost" onclick={() => e621Act(api.disconnectE621)}>{s.e621Disconnect}</Button>
  </Inline>
{/if}
{#if !e621.connected || e621.error === "unauthorized"}
  <Inline gap="sm" wrap>
    <TextField label={s.e621User} bind:value={e621User} size="sm" />
    <TextField label={s.e621Key} bind:value={e621Key} type="password" size="sm" />
    <Button size="sm" variant="secondary" onclick={connectE621}>{s.e621Connect}</Button>
  </Inline>
  {#if e621Msg}<Alert tone="danger" title={e621Msg} />{/if}
{/if}
