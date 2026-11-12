<script lang="ts">
  // The user's pairs: invitations, the pairs with their sharing switch, and the own pending invites.
  import { Alert, Button, EmptyState, Heading, IconButton, Inline, Spinner, Stack, Switch, Text } from "@cofob2/design-system-svelte";
  import { ArrowLeft, ChartNoAxesCombined, Check, Contact, Link, X } from "@lucide/svelte";
  import { api, type PairView } from "./api";
  import { fill, s } from "./strings";
  import { confirm, openTelegram, tg } from "./telegram";

  interface Props {
    onBack: () => void;
    onOpen: (id: string) => void;
  }
  let { onBack, onOpen }: Props = $props();

  let pairs = $state<PairView[] | null>(null);
  let bot = $state("");
  let link = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let error = $state(false);

  const load = () =>
    api.pairs().then((r) => {
      pairs = r.pairs;
      bot = r.bot;
    });
  load().catch(() => (error = true));

  async function run(key: string, fn: () => Promise<unknown>) {
    busy = key;
    try {
      await fn();
      await load();
    } catch {
      error = true;
    } finally {
      busy = null;
    }
  }

  const name = (p: PairView) => p.partner.name ?? (p.partner.username ? `@${p.partner.username}` : s.pairSomeone);
  const incoming = $derived(pairs?.filter((p) => p.status === "pending" && p.incoming) ?? []);
  const active = $derived(pairs?.filter((p) => p.status === "active") ?? []);
  const outgoing = $derived(pairs?.filter((p) => p.status === "pending" && !p.incoming) ?? []);

  // Mini App: Telegram's chat picker with a prepared message; web (or older clients): the link to the clipboard.
  const invite = () =>
    run("invite", async () => {
      const r = await api.pairInvite();
      if (r.prepared && tg?.isVersionAtLeast("8.0")) return tg.shareMessage(r.prepared);
      await navigator.clipboard.writeText(r.link).catch(() => {});
      link = r.link;
    });

  // Mini App 9.6+: Telegram's own user picker; the choice reaches the bot, which sends the invite. Else: the picker in the bot chat.
  const pick = () =>
    tg?.requestChat && tg.isVersionAtLeast("9.6")
      ? run("pick", async () => {
          const { id } = await api.pairPick();
          tg!.requestChat!(id, (sent) => sent && setTimeout(() => load().catch(() => {}), 1500));
        })
      : openTelegram(`https://t.me/${bot}?start=pair`);

  const end = async (p: PairView) => (await confirm(fill(s.pairEndConfirm, { name: name(p) }))) && run(`end:${p.id}`, () => api.pairEnd(p.id));
</script>

<Stack gap="md">
  <div class="head">
    <IconButton label={s.anBack} variant="ghost" size="sm" onclick={onBack}><ArrowLeft size={18} /></IconButton>
    <Heading as="h2" size="md" class="title">{s.pairs}</Heading>
  </div>
  <Text tone="muted" size="sm">{s.pairsIntro}</Text>
  {#if error}<Alert tone="danger" title={s.error} dismissible onDismiss={() => (error = false)} />{/if}
  <Inline gap="sm" wrap>
    <Button onclick={invite} loading={busy === "invite"}>
      {#snippet leading()}<Link size={16} aria-hidden="true" />{/snippet}
      {s.pairInvite}
    </Button>
    <Button variant="secondary" disabled={!bot} loading={busy === "pick"} onclick={pick}>
      {#snippet leading()}<Contact size={16} aria-hidden="true" />{/snippet}
      {s.pairPick}
    </Button>
  </Inline>
  {#if link}<Text tone="muted" size="sm" class="pair-link">{s.pairCopied} {link}</Text>{/if}

  {#if !pairs}
    {#if !error}<Spinner label="Loading" />{/if}
  {:else if !pairs.length}
    <EmptyState title={s.pairNone} description={s.pairNoneHint} />
  {:else}
    {#if incoming.length}
      <Heading as="h3" size="sm">{s.pairIncoming}</Heading>
      {#each incoming as p (p.id)}
        <section class="card">
          <Text><b>{name(p)}</b> {s.pairWants}</Text>
          <Inline gap="sm" wrap>
            <Button size="sm" loading={busy === `ok:${p.id}`} onclick={() => run(`ok:${p.id}`, () => api.pairAccept(p.id))}>
              {#snippet leading()}<Check size={16} aria-hidden="true" />{/snippet}
              {s.pairAccept}
            </Button>
            <Button size="sm" variant="ghost" loading={busy === `no:${p.id}`} onclick={() => run(`no:${p.id}`, () => api.pairDecline(p.id))}>
              {#snippet leading()}<X size={16} aria-hidden="true" />{/snippet}
              {s.pairDecline}
            </Button>
          </Inline>
        </section>
      {/each}
    {/if}
    {#if active.length}
      <Heading as="h3" size="sm">{s.pairActive}</Heading>
      {#each active as p (p.id)}
        <section class="card">
          <Heading as="h4" size="sm">{name(p)}</Heading>
          <Text tone="muted" size="sm">{fill(p.they_share ? s.pairTheyShow : s.pairTheyHide, { name: name(p) })}</Text>
          <Switch label={s.pairShare} checked={p.i_share} disabled={busy === `share:${p.id}`} onCheckedChange={(on) => run(`share:${p.id}`, () => api.pairShare(p.id, on))} />
          <Inline gap="sm" wrap>
            <Button size="sm" variant="secondary" onclick={() => onOpen(p.id)}>
              {#snippet leading()}<ChartNoAxesCombined size={16} aria-hidden="true" />{/snippet}
              {s.pairStats}
            </Button>
            <Button size="sm" variant="ghost" loading={busy === `end:${p.id}`} onclick={() => end(p)}>{s.pairEnd}</Button>
          </Inline>
        </section>
      {/each}
    {/if}
    {#if outgoing.length}
      <Heading as="h3" size="sm">{s.pairOutgoing}</Heading>
      {#each outgoing as p (p.id)}
        <section class="card row">
          <Text>{p.partner.id ? name(p) : s.pairOpenLink} · {new Date(p.created_at * 1000).toLocaleDateString()}</Text>
          <Button size="sm" variant="ghost" loading={busy === `end:${p.id}`} onclick={() => run(`end:${p.id}`, () => api.pairEnd(p.id))}>{s.pairCancel}</Button>
        </section>
      {/each}
    {/if}
  {/if}
</Stack>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: var(--cf-space-2);
  }
  .head > :global(:first-child) {
    margin-inline-start: calc((1rem - var(--cf-control-height-sm)) / 2);
  }
  .head :global(.title) {
    margin: 0;
    line-height: 1.2;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: var(--cf-space-2);
    border: 1px solid var(--cf-color-border);
    border-radius: var(--cf-radius-lg);
    padding: var(--cf-space-3);
  }
  .card :global(h4) {
    margin: 0;
  }
  .row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }
  :global(.pair-link) {
    overflow-wrap: anywhere;
  }
</style>
