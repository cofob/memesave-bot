<script lang="ts">
  import { Alert, Button, Drawer, Heading, Inline, Progress, Select, Spinner, Stack, Tabs, Text, TextField } from "@cofob2/design-system-svelte";
  import { Archive } from "@lucide/svelte";
  import { api, type AllStats, type ExportStatus, type ImportRow, type Me, type Stats, type UsersList } from "./api";
  import { fileSize, fill, s, usd } from "./strings";
  import { confirm, openExternal, tg } from "./telegram";
  import { addFiles } from "./uploads.svelte";
  import Billing from "./Billing.svelte";
  import Channels from "./Channels.svelte";
  import Connections from "./Connections.svelte";

  interface Props {
    me: Me;
    open: boolean;
    onClose: () => void;
    onMeChange: (me: Me) => void;
    tab?: string;
  }
  let { me, open, onClose, onMeChange, tab = $bindable("stats") }: Props = $props();

  const tabs = $derived([
    ...(me.role === "paid" ? [{ id: "billing", label: s.tabBilling }] : []),
    { id: "stats", label: s.tabStats },
    { id: "settings", label: s.tabSettings },
    { id: "batch", label: s.tabBatch },
    ...(me.role === "admin" ? [{ id: "admin", label: s.tabAdmin }] : []),
    { id: "about", label: s.tabAbout },
  ]);

  let stats = $state<Stats | null>(null);
  let all = $state<AllStats | null>(null);
  let showAll = $state(false);
  let batch = $state<{ collecting: ImportRow | null; recent: ImportRow[]; failed: number } | null>(null);
  let users = $state<UsersList | null>(null);
  let exp = $state<ExportStatus | null>(null);
  let message = $state<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  let busy = $state(false);
  let target = $state("");
  let role = $state("user");
  let zipInput = $state<HTMLInputElement>();

  // Load the data of the visible tab each time it is shown.
  $effect(() => {
    if (!open) return;
    message = null;
    if (tab === "stats") api.stats().then((v) => (stats = v), () => {});
    if (tab === "batch") api.batch().then((v) => (batch = v), () => {});
    if (tab === "admin") api.users().then((v) => (users = v), () => {});
    if (tab === "settings") api.exportStatus().then((v) => (exp = v), () => {});
    if (tab === "settings") api.accountSummary().then((v) => (summary = v), () => {});
  });

  // Export progress while the Settings tab is open.
  $effect(() => {
    if (!open || tab !== "settings") return;
    const timer = setInterval(() => exp?.status === "running" && api.exportStatus().then((v) => (exp = v), () => {}), 10_000);
    return () => clearInterval(timer);
  });
  const DELETE_CONFIRM = "DELETE"; // same phrase as the bot's /delete_all
  let summary = $state<{ memes: number; payments: number } | null>(null);
  let deleteText = $state("");
  async function deleteAll() {
    await api.deleteAccount(deleteText);
    if (tg) return tg.close();
    await api.logout();
    location.reload();
  }
  const exportBlocked = $derived(!!exp?.next_at && exp.next_at > Date.now() / 1000);

  // Live batch progress while the Batch tab is open and something is running.
  const running = (r: ImportRow) => ["submitting", "submitted", "processing"].includes(r.status) || r.pending > 0;
  $effect(() => {
    if (!open || tab !== "batch") return;
    const timer = setInterval(() => batch?.recent.some(running) && api.batch().then((v) => (batch = v), () => {}), 10_000);
    return () => clearInterval(timer);
  });

  async function act(fn: () => Promise<unknown>, success?: string) {
    busy = true;
    message = null;
    try {
      await fn();
      if (success) message = { tone: "success", text: success };
    } catch {
      message = { tone: "danger", text: s.error };
    } finally {
      busy = false;
    }
  }

  const reloadBatch = async () => (batch = await api.batch());
  const reloadUsers = async () => (users = await api.users());

  async function adminAction(kind: "grant" | "revoke", who: string) {
    await act(async () => {
      const res = kind === "grant" ? await api.grant(who, role) : await api.revoke(who);
      const text = fill((s as Record<string, string>)[`adminResult_${res.result}`] ?? res.result, { target: res.target });
      message = { tone: res.result.startsWith("grant") || res.result === "revoked" ? "success" : "danger", text };
      if (res.result === "granted" || res.result === "granted_pending" || res.result === "revoked") {
        target = "";
        await reloadUsers();
      }
    });
  }

  const date = (t: number) => new Date(t * 1000).toLocaleString();
</script>

<Drawer {open} title={s.account} side="right" closeLabel={s.close} onOpenChange={(o) => !o && onClose()}>
  <Stack gap="md">
    <Tabs {tabs} bind:value={tab} label={s.account} class="account-tabs">
      {#snippet children(current)}
        <div class="panel">
          {#if message}<Alert tone={message.tone} title={message.text} />{/if}

          {#if current.id === "billing"}
            <Billing />
          {:else if current.id === "stats"}
            {#if !stats}
              <Spinner label="Loading" />
            {:else}
              <dl class="grid">
                <dt>{s.statMemes}</dt><dd>{stats.total}</dd>
                <dt>{s.statPhotos} / {s.statVideos} / {s.statGifs}</dt><dd>{stats.photo} / {stats.video} / {stats.animation}</dd>
                <dt>{s.statPending}</dt><dd>{stats.pending}</dd>
                <dt>{s.statFailed}</dt><dd>{stats.failed}</dd>
                <dt>{s.statStorage}</dt><dd>{fileSize(stats.bytes)}</dd>
                <dt>{s.statSpend}</dt><dd>{usd(stats.spend)} <small>({s.statBotKey} {usd(stats.global)}, {s.statOwnKey} {usd(stats.own)})</small></dd>
                <dt>{s.statSpend30}</dt><dd>{usd(stats.spend30)}</dd>
                <dt>{s.statAvg}</dt><dd>{usd(stats.avg)}</dd>
              </dl>
              {#if stats.kinds.length}
                <Heading as="h3" size="sm">{s.statByKind}</Heading>
                <dl class="grid">
                  {#each stats.kinds as k (k.kind)}<dt>{k.kind}</dt><dd>{usd(k.cost)} <small>({k.count})</small></dd>{/each}
                </dl>
              {/if}
              {#if me.role === "admin"}
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={async () => {
                    showAll = !showAll;
                    if (showAll) all = await api.allStats();
                  }}>{s.statAllUsers}</Button
                >
                {#if showAll && all}
                  <dl class="grid">
                    {#each all.users as u (u.id)}
                      <dt>{u.username ? `@${u.username}` : u.id}</dt>
                      <dd>{u.memes} · {usd(u.total_cost)} <small>({s.statBotKey} {usd(u.global)})</small></dd>
                    {/each}
                    <dt>{s.statTotal}</dt><dd>{usd(all.total)} <small>({s.statBotKey} {usd(all.global)})</small></dd>
                  </dl>
                {/if}
              {/if}
            {/if}
          {:else if current.id === "settings"}
            <Select
              label={s.searchModeLabel}
              value={me.search_mode}
              options={[
                { value: "advanced", label: s.searchModeAdvanced },
                { value: "fast", label: s.searchModeFast },
              ]}
              onchange={(e: Event) => {
                const mode = (e.currentTarget as HTMLSelectElement).value as Me["search_mode"];
                act(() => api.setSettings({ search_mode: mode }), s.stateReady).then(() => onMeChange({ ...me, search_mode: mode }));
              }}
            />
            <Select
              label={s.tierLabel}
              value={me.describe_tier}
              options={[
                { value: "max", label: s.tierMax },
                { value: "medium", label: s.tierMedium },
              ]}
              onchange={(e: Event) => {
                const tier = (e.currentTarget as HTMLSelectElement).value as Me["describe_tier"];
                act(() => api.setSettings({ describe_tier: tier }), s.stateReady).then(() => onMeChange({ ...me, describe_tier: tier }));
              }}
            />
            <Channels />
            <Connections />
            <Heading as="h3" size="sm">{s.keyTitle}</Heading>
            <Text tone="muted">{me.key ? s.keyOwn : s.keyShared}</Text>
            <Inline gap="sm" wrap>
              <Button size="sm" loading={busy} onclick={() => act(async () => openExternal((await api.connectKey()).url))}>{s.keyConnect}</Button>
              {#if me.key}
                <Button
                  size="sm"
                  variant="danger"
                  onclick={() => act(() => api.removeKey(), s.stateReady).then(() => onMeChange({ ...me, key: false }))}>{s.keyRemove}</Button
                >
              {/if}
            </Inline>
            <Heading as="h3" size="sm">{s.exportTitle}</Heading>
            <Text tone="muted" size="sm">{s.exportHint}</Text>
            {#if exp?.status === "running"}
              <Inline gap="sm" align="center"><Spinner label="Loading" /><Text>{s.exportRunning}</Text></Inline>
            {:else if exp?.status === "failed"}
              <Text tone="muted">{fill(s.exportFailed, { error: exp.error ?? "" })}</Text>
            {/if}
            <Inline gap="sm" align="center" wrap>
              {#if exp?.url}
                <Button size="sm" onclick={() => openExternal(exp!.url!)}>{s.exportDownload}</Button>
              {/if}
              {#if exportBlocked}
                {#if exp?.status !== "running"}<Text tone="muted" size="sm">{fill(s.exportNext, { time: date(exp!.next_at!) })}</Text>{/if}
              {:else}
                <Button size="sm" variant="secondary" loading={busy} onclick={() => act(async () => (await api.exportStart(), (exp = await api.exportStatus())))}
                  >{s.exportStart}</Button
                >
              {/if}
            </Inline>
            <Heading as="h3" size="sm">{s.deleteTitle}</Heading>
            <Text tone="muted" size="sm">{fill(s.deleteWarn, { memes: summary?.memes ?? "…", payments: summary?.payments ?? "…" })}</Text>
            <Inline gap="sm" align="end" wrap>
              <TextField label={fill(s.deleteLabel, { confirm: DELETE_CONFIRM })} bind:value={deleteText} size="sm" />
              <Button size="sm" variant="danger" loading={busy} disabled={deleteText !== DELETE_CONFIRM} onclick={() => act(deleteAll)}>{s.deleteButton}</Button>
            </Inline>
          {:else if current.id === "batch"}
            {#if !batch}
              <Spinner label="Loading" />
            {:else}
              <Text>{batch.collecting ? fill(s.batchOn, { n: batch.collecting.photos }) : s.batchOff}</Text>
              <Inline gap="sm" wrap>
                {#if batch.collecting}
                  <Button size="sm" loading={busy} onclick={() => act(() => api.batchFinish().then(reloadBatch), s.batchSubmitted)}>{s.batchFinish}</Button>
                  <Button size="sm" variant="secondary" onclick={() => act(() => api.batchCancel().then(reloadBatch))}>{s.batchCancel}</Button>
                {:else}
                  <Button size="sm" loading={busy} onclick={() => act(() => api.batchStart().then(reloadBatch))}>{s.batchStart}</Button>
                {/if}
                <Button size="sm" variant="secondary" onclick={() => zipInput?.click()}>
                  {#snippet leading()}<Archive size={16} aria-hidden="true" />{/snippet}
                  {s.batchZip}
                </Button>
              </Inline>
              <Text tone="muted" size="sm">{s.batchZipHint}</Text>
              <input
                bind:this={zipInput}
                type="file"
                accept=".zip,application/zip"
                hidden
                onchange={(e) => {
                  addFiles(e.currentTarget.files ?? []);
                  e.currentTarget.value = "";
                  onClose();
                }}
              />
              {#if batch.failed}
                <Inline gap="sm" align="center" wrap>
                  <Text tone="muted">{fill(s.batchFailedN, { n: batch.failed })}</Text>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    onclick={() =>
                      act(async () => {
                        const r = await api.batchRetry();
                        message = { tone: "success", text: fill(s.batchRetried, r) };
                        await reloadBatch();
                      })}>{s.batchRetry}</Button
                  >
                </Inline>
              {/if}
              {#if batch.recent.length}
                <Heading as="h3" size="sm">{s.batchRecent}</Heading>
                <ul class="batches">
                  {#each batch.recent as b (b.id)}
                    <li>
                      <Progress
                        value={b.photos ? Math.round((b.ready / b.photos) * 100) : 0}
                        label={`${date(b.created_at)} · ${b.status} · ${b.photos}`}
                        animated={running(b)}
                        showValue
                      />
                      <small>{fill(s.batchRow, { ready: b.ready, pending: b.pending, failed: b.failed, attempts: b.attempts, cost: usd(b.cost) })}</small>
                      {#if b.live}<small>{fill(s.batchLive, b.live)}</small>{/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
          {:else if current.id === "admin"}
            <Inline gap="sm" align="end" wrap>
              <TextField label={s.adminTarget} bind:value={target} size="sm" />
              <Select
                bind:value={role}
                size="sm"
                aria-label="Role"
                options={[
                  { value: "user", label: s.adminRoleUser },
                  { value: "admin", label: s.adminRoleAdmin },
                  { value: "paid", label: s.adminRolePaid },
                ]}
              />
              <Button size="sm" loading={busy} disabled={!target.trim()} onclick={() => adminAction("grant", target)}>{s.adminGrant}</Button>
            </Inline>
            {#if !users}
              <Spinner label="Loading" />
            {:else}
              <Heading as="h3" size="sm">{s.adminUsers}</Heading>
              <ul class="rows">
                {#each users.users as u (u.id)}
                  <li>
                    <span>{u.username ? `@${u.username}` : u.id} · {u.role} · {u.memes} · {usd(u.total_cost)}</span>
                    {#if u.id !== me.id}
                      <Button
                        size="sm"
                        variant="ghost"
                        onclick={async () => (await confirm(`${s.adminRevoke}: ${u.username ? `@${u.username}` : u.id}?`)) && adminAction("revoke", String(u.id))}
                        >{s.adminRevoke}</Button
                      >
                    {/if}
                  </li>
                {/each}
              </ul>
              {#if users.grants.length}
                <Heading as="h3" size="sm">{s.adminPending}</Heading>
                <ul class="rows">
                  {#each users.grants as g (g.username)}
                    <li>
                      <span>@{g.username} · {g.role}</span>
                      <Button size="sm" variant="ghost" onclick={() => adminAction("revoke", `@${g.username}`)}>{s.adminRevoke}</Button>
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
          {:else if current.id === "about"}
            <Text>{s.aboutText}</Text>
            <Heading as="h3" size="sm">{s.aboutModels}</Heading>
            <dl class="grid">
              {#each Object.entries(me.models) as [name, model] (name)}<dt>{name}</dt><dd><code>{model}</code></dd>{/each}
            </dl>
            {#if !tg}<Text tone="muted" size="sm">{me.username ? `@${me.username}` : me.id} · {me.role}</Text>{/if}
          {/if}
        </div>
      {/snippet}
    </Tabs>
  </Stack>
</Drawer>

<style>
  .panel {
    display: grid;
    gap: var(--cf-space-3);
    padding-block-start: var(--cf-space-3);
  }
  .grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--cf-space-1) var(--cf-space-4);
    margin: 0;
  }
  .grid dt {
    color: var(--cf-color-text-muted);
  }
  .grid dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  /* Five tabs do not fit a narrow drawer: scroll them sideways without a visible scrollbar. */
  :global(.account-tabs .cf-tabs__list) {
    overflow-x: auto;
    scrollbar-width: none;
  }
  :global(.account-tabs .cf-tabs__list::-webkit-scrollbar) {
    display: none;
  }
  .batches {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--cf-space-3);
  }
  .batches li {
    display: grid;
    gap: var(--cf-space-1);
  }
  .batches small {
    color: var(--cf-color-text-muted);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--cf-space-1);
  }
  .rows li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cf-space-2);
  }
</style>
