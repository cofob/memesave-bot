<script lang="ts">
  import { Alert, Button, Heading, Inline, Progress, Select, Spinner, Text } from "@cofob2/design-system-svelte";
  import qrcode from "qrcode-generator";
  import { onDestroy } from "svelte";
  import { api, type Billing, type CryptoInvoice, type ProductKind } from "./api";
  import { paywall } from "./paywall.svelte";
  import { fill, s } from "./strings";
  import { openTab, tg } from "./telegram";

  let billing = $state<Billing | null>(null);
  let method = $state("stars"); // stars | btcpay | usdt:<SHKeeper crypto>
  let invoice = $state<CryptoInvoice | null>(null);
  let paid = $state(false);
  let failed = $state(false);
  let busy = $state(false);
  let copied = $state(false);

  const load = async () => {
    billing = await api.billing();
    if (billing.free || (billing.active && (billing.ownKey || billing.balance > 0 || billing.allowanceLeft > 0))) paywall.reason = null;
  };
  load().catch(() => (failed = true));

  const money = (x: number) => `$${x.toFixed(2)}`;
  const date = (t: number) => new Date(t * 1000).toLocaleDateString();
  const stars = $derived(method === "stars");
  const methods = $derived(
    billing
      ? [
          { value: "stars", label: s.billStars },
          ...(billing.methods.btcpay ? [{ value: "btcpay", label: s.billBtc }] : []),
          ...billing.methods.usdt.map((c) => ({ value: `usdt:${c}`, label: fill(s.billUsdt, { network: c }) })),
        ]
      : [],
  );
  const qr = $derived.by(() => {
    if (!invoice?.address) return "";
    const code = qrcode(0, "M");
    code.addData(invoice.address);
    code.make();
    return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  });

  // Polls until the payment arrives (or 60 minutes pass): the crypto invoice status, or the plan for Stars on the web.
  let timer: ReturnType<typeof setInterval> | undefined;
  function watch(check: () => Promise<boolean>) {
    clearInterval(timer);
    const until = Date.now() + 60 * 60_000;
    timer = setInterval(async () => {
      if (Date.now() > until) return clearInterval(timer);
      if (await check().catch(() => false)) {
        clearInterval(timer);
        paid = true;
        invoice = null;
        await load();
      }
    }, 5000);
  }
  onDestroy(() => clearInterval(timer));

  async function buy(kind: ProductKind, amount?: number) {
    busy = true;
    failed = paid = false;
    try {
      if (stars) {
        const before = JSON.stringify([billing?.paidUntil, billing?.balance]);
        const { url } = await api.starsInvoice(kind, amount);
        if (tg) tg.openInvoice(url, (status) => status === "paid" && watch(async () => true));
        else {
          openTab(url); // t.me/$… opens Telegram to pay
          watch(async () => {
            const b = await api.billing();
            return JSON.stringify([b.paidUntil, b.balance]) !== before;
          });
        }
      } else {
        const provider = method === "btcpay" ? "btcpay" : "shkeeper";
        const inv = await api.cryptoInvoice({ provider, kind, usd: amount, crypto: method.startsWith("usdt:") ? method.slice(5) : undefined });
        if (inv.url) openTab(inv.url);
        invoice = inv.address ? inv : null;
        watch(async () => (await api.cryptoStatus(inv.id)).status === "paid");
      }
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function autorenew(on: boolean) {
    busy = true;
    await api.autorenew(on).then(load, () => (failed = true));
    busy = false;
  }

  async function copy() {
    await navigator.clipboard.writeText(invoice?.address ?? "");
    copied = true;
  }
</script>

{#if paid}<Alert tone="success" title={s.billPaid} />{/if}
{#if failed}<Alert tone="danger" title={s.error} />{/if}
{#if !billing}
  <Spinner label="Loading" />
{:else if billing.free}
  <Text>{s.billFree}</Text>
{:else}
  <dl class="grid">
    <dt>{s.billPlan}</dt>
    <dd>{billing.active && billing.paidUntil ? fill(s.billActiveUntil, { date: date(billing.paidUntil) }) : s.billNone}</dd>
    <dt>{s.billBalance}</dt>
    <dd>{money(billing.balance)}</dd>
  </dl>
  {#if billing.active && !billing.byok}
    <Progress
      value={Math.round((billing.allowanceLeft / billing.allowance) * 100)}
      label={fill(s.billAllowance, { left: money(billing.allowanceLeft), allowance: money(billing.allowance) })}
    />
  {/if}
  {#if billing.active && billing.plan === "monthly" && billing.subState}
    <Inline gap="sm" align="center" wrap>
      <Text tone="muted" size="sm">{fill(s.billRenewState, { state: billing.subState === "active" ? s.billOn : s.billOff })}</Text>
      <Button size="sm" variant="secondary" loading={busy} onclick={() => autorenew(billing?.subState !== "active")}>
        {billing.subState === "active" ? s.billRenewOff : s.billRenewOn}
      </Button>
    </Inline>
  {/if}

  {#if methods.length > 1}<Select label={s.billMethod} bind:value={method} options={methods} />{/if}
  {#if stars && !tg}<Text tone="muted" size="sm">{s.billWebHint}</Text>{/if}

  <Heading as="h3" size="sm">{s.billPlans}</Heading>
  <Text tone="muted" size="sm">{billing.ownKey ? s.billByokHint : fill(s.billIncludedHint, { allowance: money(billing.allowance) })}</Text>
  <Inline gap="sm" wrap>
    {#each ["monthly", "yearly"] as const as kind (kind)}
      {@const p = billing.prices[kind]}
      <Button size="sm" loading={busy} onclick={() => buy(kind)}>
        {fill(kind === "monthly" ? s.billMonthly : s.billYearly, { price: stars ? `${p.stars}⭐` : money(p.usd) })}
      </Button>
    {/each}
  </Inline>

  <Heading as="h3" size="sm">{s.billTopup}</Heading>
  <Inline gap="sm" wrap>
    {#if stars}
      {#each billing.starTopups as x (x.stars)}
        <Button size="sm" variant="secondary" loading={busy} onclick={() => buy("topup", x.stars)}>{x.stars}⭐ → +{money(x.usd)}</Button>
      {/each}
    {:else}
      {#each billing.cryptoTopups as x (x)}
        <Button size="sm" variant="secondary" loading={busy} onclick={() => buy("topup", x)}>{money(x)}</Button>
      {/each}
    {/if}
  </Inline>

  {#if invoice?.address}
    <Text>{fill(s.billUsdtSend, { amount: invoice.amount ?? "", network: invoice.crypto ?? "" })}</Text>
    <code class="address">{invoice.address}</code>
    <Inline gap="sm" align="center" wrap>
      <Button size="sm" variant="secondary" onclick={copy}>{copied ? s.billCopied : s.billCopy}</Button>
      <Text tone="muted" size="sm">{s.billWaiting}</Text>
    </Inline>
    <div class="qr">{@html qr}</div>
  {/if}
{/if}

<style>
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
  .address {
    overflow-wrap: anywhere;
    user-select: all;
  }
  .qr {
    inline-size: 12rem;
    padding: var(--cf-space-2);
    background: #fff;
    border-radius: var(--cf-radius-md);
  }
</style>
