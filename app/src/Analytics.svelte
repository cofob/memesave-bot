<script lang="ts">
  import { Alert, Button, Checkbox, EmptyState, Heading, IconButton, Inline, Progress, Spinner, Stack, Table, Tabs } from "@cofob2/design-system-svelte";
  import { ArrowLeft, Sparkles } from "@lucide/svelte";
  import { onDestroy, untrack } from "svelte";
  import { api, type AdminAnalytics, type AnalysisResult, type AnalysisRun, type Me, type PornSide, type SharedParts } from "./api";
  import Chart from "./Chart.svelte";
  import { autoHeight, bars, columns, hexAlpha, isDark, PALETTE, cumulative, dayRange, esc, heatmap, line, money, stacked, topGroups } from "./charts";
  import Embeddings from "./Embeddings.svelte";
  import ShareLink from "./ShareLink.svelte";
  import Thumbs from "./Thumbs.svelte";
  import { fileSize, fill, isRu, s, usd } from "./strings";

  interface Props {
    me?: Me;
    onBack?: () => void;
    onTag?: (tag: string) => void;
    onOpen?: (id: string) => void;
    tab?: string;
    shared?: AnalysisResult; // a public link: read-only, no spend
    parts?: SharedParts; // what the link shares (an old one: regular stats only)
  }
  let { me, onBack, onTag = () => {}, onOpen = () => {}, tab = $bindable("mine"), shared: sharedProp, parts: sharedParts }: Props = $props();
  const shared = untrack(() => sharedProp); // a fixed snapshot
  const parts = shared ? (untrack(() => sharedParts) ?? { normal: true, porn: false }) : { normal: true, porn: true };

  // Tabs only for admins: their own stats and all users.
  const tabs = [
    { id: "mine", label: s.anMine },
    { id: "admin", label: s.anAdmin },
  ];
  let admin = $state<AdminAnalytics | null>(null);
  let error = $state(false);

  // Everything here comes from one daily analysis: the SQL stats snapshot and the embedding maps (the bot
  // report shows the same one).
  let run = $state<AnalysisRun | null>(null);
  let ready = $state<AnalysisRun | null>(null);
  let result = $state.raw<AnalysisResult | null>(shared ?? null);
  let loading = $state(!shared);
  let starting = $state(false);
  let llm = $state(true);
  let timer: ReturnType<typeof setTimeout>;
  const data = $derived(parts.normal ? (result?.analytics ?? null) : null);
  const porn = $derived(parts.porn && !me?.hide_porn ? (result?.analytics?.porn ?? null) : null);
  const stats = $derived(data?.stats ?? null);

  async function refresh() {
    clearTimeout(timer);
    try {
      const st = await api.analysis();
      run = st.current;
      // AI names added later keep the analysis id: reload the result when they appear.
      if (st.ready && (st.ready.id !== ready?.id || st.ready.labeled !== ready?.labeled)) result = await api.analysisResult();
      ready = st.ready;
      if (run?.status === "running") timer = setTimeout(refresh, 2000);
    } catch {
      error = true;
    } finally {
      loading = false;
    }
  }

  async function start(withLlm: boolean) {
    starting = true;
    try {
      run = await api.analysisStart(withLlm);
      await refresh();
    } catch {
      error = true;
    } finally {
      starting = false;
    }
  }

  if (!shared) refresh();
  onDestroy(() => clearTimeout(timer));

  const running = $derived(run?.status === "running");
  // A result from before moods can be redone at once (the server agrees when AI is available).
  const canStart = $derived(!running && (!ready || Date.now() / 1000 > ready.fresh_until || (!!result && !result.moods)));
  const percent = $derived(run && run.total ? Math.round((run.done / run.total) * 100) : undefined);
  const stage = $derived((s as unknown as Record<string, string>)[`anStage_${run?.stage ?? "queued"}`] ?? run?.stage ?? "");
  const date = (t: number) => new Date(t * 1000).toLocaleString();
  $effect(() => {
    if (tab === "admin" && !admin) api.adminAnalytics().then((v) => (admin = v), () => (error = true));
  });

  const counts = (rows: { k: string | null; n: number }[], name = (k: string) => k) => rows.map((r) => ({ name: name(r.k ?? "—"), value: r.n }));
  const kindName = (k: string) => ({ photo: s.statPhotos, video: s.statVideos, animation: s.statGifs })[k] ?? k;
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(isRu ? "ru" : "en", { weekday: "short" })); // Mon..Sun
  const hours = Array.from({ length: 24 }, (_, h) => String(h));

  const overview = $derived.by(() => {
    if (!data) return null;
    const xs = dayRange(data.timeline.map((r) => r.day));
    const perDay = new Map<string, number>();
    for (const r of data.timeline) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.n);
    return {
      perDay: stacked(data.timeline, (r) => r.day, (r) => kindName(r.kind), (r) => r.n, { xs, order: KINDS.map(kindName) }),
      total: line(xs, cumulative(xs.map((d) => perDay.get(d) ?? 0)), s.anTotal),
      saved: data.saved.length ? stacked(data.saved, (r) => r.day, () => s.anSavedAt, (r) => r.n, { xs: dayRange(data.saved.map((r) => r.day)) }) : null,
      // SQLite %w: 0 = Sunday; rows here start on Monday.
      heat: heatmap(hours, weekdays, data.heatmap.map((c) => [c.h, (c.wd + 6) % 7, c.n] as [number, number, number]), s.anHeatmap),
      kinds: bars(counts(data.kinds, kindName), s.anKinds),
      statuses: bars(counts(data.statuses), s.anStatuses),
      languages: bars(counts(data.languages, (k) => k.toUpperCase()), s.anLanguages),
      sizes: ordered(data.sizes, ["<100K", "<500K", "<1M", "<5M", "<20M", "20M+"], s.anSizes),
      durations: data.durations.length ? ordered(data.durations, ["<5s", "<15s", "<30s", "<1m", "<3m", "3m+"], s.anDurations) : null,
      aspect: ordered(data.aspect, ["portrait", "square", "landscape", "wide"], s.anAspect),
      albums: data.albums.length ? columns(data.albums.map((a) => String(a.size)), data.albums.map((a) => a.n), s.anAlbums) : null,
    };
  });

  function ordered(rows: { k: string | null; n: number }[], order: string[], name: string) {
    return columns(order, order.map((k) => rows.find((r) => r.k === k)?.n ?? 0), name);
  }

  const KINDS = ["photo", "video", "animation"];
  const ORIGINS = ["channel", "group", "user", "link", "direct"] as const;
  const VIA = ["bot", "web", "miniapp", "api", "mcp", "zip", "unknown"] as const;
  const USE_VIA = ["inline", "share", "send"] as const;
  const word = (key: string) => (s as unknown as Record<string, string>)[key] ?? key;

  const sourceCharts = $derived.by(() => {
    if (!data) return null;
    const o = data.origins;
    const addedTotal = new Map<string, number>();
    for (const r of data.added) addedTotal.set(r.via, (addedTotal.get(r.via) ?? 0) + r.n);
    return {
      kinds: bars(o.kinds.map((k) => ({ name: word(`anOrigin_${k.kind}`), value: k.n })), s.anOriginKinds),
      top: o.top.length
        ? {
            ...bars(o.top.map((t) => ({ name: t.name, value: t.n })), s.anTopSources),
            tooltip: { trigger: "item", formatter: (p: any) => `${esc(p.name)}<br>${fill(s.anSourceUses, { n: p.value, uses: o.top.find((t) => t.name === p.name)?.uses ?? 0 })}` },
          }
        : null,
      months: stacked(
        o.months.flatMap((m) => Object.entries(m.counts).map(([kind, n]) => ({ month: m.month, kind, n: n ?? 0 }))),
        (r) => r.month,
        (r) => word(`anOrigin_${r.kind}`),
        (r) => r.n,
        { order: ORIGINS.map((k) => word(`anOrigin_${k}`)) },
      ),
      via: bars(VIA.filter((v) => addedTotal.has(v)).map((v) => ({ name: word(`anVia_${v}`), value: addedTotal.get(v)! })), s.anAddedVia),
      viaMonths: stacked(data.added, (r) => r.month, (r) => word(`anVia_${r.via}`), (r) => r.n, {
        order: VIA.map((v) => word(`anVia_${v}`)),
        muted: s.anVia_unknown,
      }),
    };
  });

  const useCharts = $derived.by(() => {
    if (!data?.uses.days.length) return null;
    const xs = dayRange(data.uses.days.map((d) => d.day));
    return stacked(data.uses.days, (r) => r.day, (r) => word(`anVia_${r.via}`), (r) => r.n, { xs, order: USE_VIA.map((v) => word(`anVia_${v}`)) });
  });

  const tagCharts = $derived.by(() => {
    if (!data) return null;
    const t = data.tags;
    const months = t.trend.months.map((m) => m.month);
    return {
      top: bars(t.top.slice(0, 40).map((x) => ({ name: x.tag, value: x.count })), s.anTopTags),
      tree: {
        tooltip: { formatter: (p: any) => `#${esc(p.name)}: <b>${p.value}</b>` },
        series: [
          {
            type: "treemap",
            // One hue; a darker box has more memes (alpha by the square root of the count).
            data: t.top.map((x) => ({
              name: x.tag,
              value: x.count,
              itemStyle: { color: hexAlpha(isDark() ? PALETTE.dark[0] : PALETTE.light[0], 0.35 + 0.65 * Math.sqrt(x.count / (t.top[0]?.count || 1))) },
            })),
            roam: false,
            nodeClick: false,
            breadcrumb: { show: false },
            itemStyle: { gapWidth: 2, borderWidth: 0 },
            label: { formatter: "{b}" },
            left: 0, // edge to edge: the defaults center it with an offset
            top: 0,
            right: 0,
            bottom: 0,
          },
        ],
      },
      cooc: heatmap(
        t.cooc.tags,
        t.cooc.tags,
        t.cooc.matrix.flatMap((row, i) => row.map((n, j) => [j, i, n] as [number, number, number])),
        s.anCooc,
      ),
      trend: {
        legend: { top: 0, type: "scroll" },
        tooltip: { trigger: "axis" },
        xAxis: { type: "category", data: months, boundaryGap: false },
        yAxis: { type: "value" },
        series: t.trend.tags.map((tag) => ({
          name: tag,
          type: "line",
          showSymbol: false,
          lineStyle: { width: 2 },
          emphasis: { focus: "series" },
          data: t.trend.months.map((m) => m.counts[tag] ?? 0),
        })),
      },
      perMeme: columns(t.perMeme.map((x) => String(x.tags)), t.perMeme.map((x) => x.n), s.anTagsPerMeme),
    };
  });

  const pornCharts = $derived.by(() => {
    if (!porn) return null;
    const months = porn.months.map((m) => m.month);
    const top = porn.sources;
    return {
      share: line(months, porn.months.map((m) => Math.round((1000 * m.porn) / (m.n || 1)) / 10), s.anPornShareMonth, (v) => `${v}%`),
      perMonth: columns(months, porn.months.map((m) => m.porn), s.anPornMonth),
      heat: heatmap(hours, weekdays, porn.heatmap.map((c) => [c.h, (c.wd + 6) % 7, c.n] as [number, number, number]), s.anPornHeat),
      tags: porn.tags.length ? bars(porn.tags.slice(0, 30).map((x) => ({ name: x.tag, value: x.count })), s.anPornTags) : null,
      sources:
        !shared && top.length
          ? {
              ...bars(top.map((t) => ({ name: t.name, value: t.n })), s.anPornSources),
              tooltip: { trigger: "item", formatter: (p: any) => `${esc(p.name)}<br>${fill(s.anSourceUses, { n: p.value, uses: top.find((t) => t.name === p.name)?.uses ?? 0 })}` },
            }
          : null,
    };
  });

  const spendCharts = $derived.by(() => {
    if (!data) return null;
    const sp = data.spend;
    const xs = dayRange(sp.days.map((r) => r.day));
    const perDay = new Map<string, number>();
    for (const r of sp.days) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.cost);
    const models = topGroups(sp.models, (m) => m.model, (m) => m.cost);
    return {
      days: stacked(sp.days, (r) => r.day, (r) => r.kind, (r) => r.cost, { xs, fmt: money }),
      total: line(xs, cumulative(xs.map((d) => perDay.get(d) ?? 0)), s.anSpendTotal, money),
      models: bars(sp.models.map((m) => ({ name: models.of(m), value: m.cost })).reduce(merge, []), s.anModels, money),
      tokens: {
        legend: { top: 0 },
        tooltip: { trigger: "axis", valueFormatter: (v: number) => v.toLocaleString() },
        grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
        xAxis: { type: "value", splitNumber: 3, axisLabel: { hideOverlap: true } },
        yAxis: { type: "category", data: sp.models.map((m) => m.model), axisLabel: { width: 160, overflow: "truncate" } },
        series: [
          { name: s.anPrompt, type: "bar", stack: "t", barMaxWidth: 18, data: sp.models.map((m) => m.prompt) },
          { name: s.anCompletion, type: "bar", stack: "t", barMaxWidth: 18, itemStyle: { borderRadius: [0, 4, 4, 0] }, data: sp.models.map((m) => m.completion) },
        ],
      },
      keys: bars(sp.keys.map((k) => ({ name: k.k === "global" ? s.statBotKey : s.statOwnKey, value: k.cost })), s.anKeys, money),
      perMeme: bars(sp.perMeme.map((k) => ({ name: k.kind, value: k.per_meme })), s.anPerMeme, money),
    };
  });

  /** Sums the values of repeated names ("other"). */
  function merge(acc: { name: string; value: number }[], x: { name: string; value: number }) {
    const same = acc.find((a) => a.name === x.name);
    if (same) same.value += x.value;
    else acc.push({ ...x });
    return acc;
  }

  const adminCharts = $derived.by(() => {
    if (!admin) return null;
    const userDays = dayRange(admin.users.map((r) => r.day));
    const perDay = new Map<string, number>();
    for (const r of admin.users) perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.n);
    return {
      users: stacked(admin.users, (r) => r.day, (r) => r.role, (r) => r.n, { xs: userDays }),
      usersTotal: line(userDays, cumulative(userDays.map((d) => perDay.get(d) ?? 0)), s.anUserTable),
      memes: stacked(admin.memes, (r) => r.day, (r) => kindName(r.kind), (r) => r.n, { xs: dayRange(admin.memes.map((r) => r.day)), order: KINDS.map(kindName) }),
      statuses: bars(counts(admin.statuses), s.anStatuses),
      errors: admin.errors.length ? bars(counts(admin.errors), s.anErrors) : null,
      spend: stacked(admin.spend, (r) => r.day, (r) => r.model, (r) => r.cost, { xs: dayRange(admin.spend.map((r) => r.day)), fmt: money }),
      keys: bars(admin.keys.map((k) => ({ name: k.k === "global" ? s.statBotKey : s.statOwnKey, value: k.cost })), s.anKeys, money),
      payments: admin.payments.length ? stacked(admin.payments, (r) => r.month, (r) => r.method, (r) => r.usd, { fmt: (v) => `$${v.toFixed(2)}` }) : null,
    };
  });
</script>

<Stack gap="md">
  <div class="head">
    {#if onBack}<IconButton label={s.anBack} variant="ghost" size="sm" onclick={onBack}><ArrowLeft size={18} /></IconButton>{/if}
    <Heading as="h2" size="md" class="title">{shared ? s.anSharedTitle : s.analytics}</Heading>
  </div>
  {#if error}<Alert tone="danger" title={s.error} />{/if}

  {#if me?.role === "admin"}
    <Tabs {tabs} bind:value={tab} label={s.analytics}>
      {#snippet children(current)}
        <div class="panel">
          {#if current.id === "admin"}{@render allUsers()}{:else}{@render mine()}{/if}
        </div>
      {/snippet}
    </Tabs>
  {:else}
    {@render mine()}
  {/if}
</Stack>

<!-- The user's stats: one page, sections in order, each with a short explanation. -->
{#snippet mine()}
  <Stack gap="lg">
    {#if !shared}{@render controls()}{/if}
    {#if result && !data && porn}{@render pornSection(porn)}{/if}
    {#if result && data && overview && tagCharts && spendCharts && sourceCharts}
      {@const u = data.uses}
      {@render section(s.anOverview, s.anIntro_overview)}
      {#if stats}
        <div class="tiles">
          {@render tile(s.statMemes, stats.total.toLocaleString())}
          {@render tile(s.statStorage, fileSize(stats.bytes))}
          {#if !shared}
            {@render tile(s.statSpend, usd(stats.spend))}
            {@render tile(s.statSpend30, usd(stats.spend30))}
            {@render tile(s.statAvg, usd(stats.avg))}
          {/if}
        </div>
      {/if}
      {#if data.timeline.length}
        <div class="grid">
          {@render card(s.anPerDay, overview.perDay)}
          {@render card(s.anTotal, overview.total)}
          {@render card(s.anHeatmap, overview.heat, "300px", undefined, s.anHint_heatmap)}
          {#if overview.saved}{@render card(s.anSavedAt, overview.saved, undefined, undefined, s.anHint_saved)}{/if}
          {@render card(s.anKinds, overview.kinds)}
          {@render card(s.anStatuses, overview.statuses, undefined, undefined, s.anHint_statuses)}
          {@render card(s.anLanguages, overview.languages, undefined, undefined, s.anHint_languages)}
          {@render card(s.anSizes, overview.sizes, "220px")}
          {@render card(s.anAspect, overview.aspect, "220px", undefined, s.anHint_aspect)}
          {#if overview.durations}{@render card(s.anDurations, overview.durations, "220px")}{/if}
          {#if overview.albums}{@render card(s.anAlbums, overview.albums, "220px", undefined, s.anHint_albums)}{/if}
        </div>
      {/if}

      {@render section(s.anSources, s.anIntro_sources)}
      <div class="grid">
        {@render card(s.anAddedVia, sourceCharts.via, undefined, undefined, s.anHint_addedVia)}
        {@render card(s.anAddedMonth, sourceCharts.viaMonths)}
        {@render card(s.anOriginKinds, sourceCharts.kinds, undefined, undefined, s.anHint_origins)}
        {@render card(s.anSourcesMonth, sourceCharts.months)}
        {#if sourceCharts.top}{@render card(s.anTopSources, sourceCharts.top, undefined, undefined, s.anHint_topSources)}{/if}
      </div>

      {@render section(s.anUses, u.since ? fill(s.anUsesSince, { date: new Date(u.since * 1000).toLocaleDateString() }) : s.anNoUses)}
      <div class="tiles">
        {@render tile(s.anNeverUsed, `${u.never.toLocaleString()} / ${u.ready.toLocaleString()}`)}
        {#if u.favorites[0]}{@render tile(s.anFavorites, fill(s.anFavoriteN, { n: u.favorites[0].n }))}{/if}
      </div>
      <div class="grid">
        {#if useCharts}{@render card(s.anUsesDay, useCharts)}{/if}
        {#if u.favorites.length}
          <section class="card">
            <Heading as="h4" size="sm">{s.anFavorites}</Heading>
            <p class="hint">{s.anHint_favorites}</p>
            <Thumbs ids={u.favorites.map((f) => f.id)} {onOpen} note={(id) => fill(s.anFavoriteN, { n: u.favorites.find((f) => f.id === id)?.n ?? 0 })} />
          </section>
        {/if}
        {#if u.forgotten.length && u.since}
          <section class="card">
            <Heading as="h4" size="sm">{s.anForgotten}</Heading>
            <p class="hint">{s.anForgottenHint}</p>
            <Thumbs
              ids={u.forgotten.map((f) => f.id)}
              {onOpen}
              note={(id) => new Date((u.forgotten.find((f) => f.id === id)?.created_at ?? 0) * 1000).toLocaleDateString()}
            />
          </section>
        {/if}
      </div>

      {@render section(s.anTags, s.anIntro_tags)}
      {#if data.tags.top.length}
        <div class="grid">
          {@render card(s.anTopTags, tagCharts.top, undefined, (p) => onTag(p.name), s.anTagHint)}
          {@render card(s.anTagTree, tagCharts.tree, `${Math.min(640, Math.max(240, data.tags.top.length * 6))}px`, (p) => p.name && onTag(p.name), s.anHint_tree)}
          {@render card(s.anCooc, tagCharts.cooc, `${Math.min(560, Math.max(200, data.tags.cooc.tags.length * 22 + 110))}px`, undefined, s.anHint_cooc)}
          {@render card(s.anTrend, tagCharts.trend, "320px", undefined, s.anHint_trend)}
          {@render card(s.anTagsPerMeme, tagCharts.perMeme, "220px")}
        </div>
      {:else}
        <p class="hint">{s.noTags}</p>
      {/if}

      {#if porn}{@render pornSection(porn)}{/if}

      {#if !shared}{@render section(s.anSpend, s.anIntro_spend)}{/if}
      {#if !shared && data.spend.days.length}
        <div class="tiles">
          {@render tile(s.anSpendTotal, usd(data.spend.covered.total))}
          {#if data.spend.covered.allowance}{@render tile(s.anAllowance, usd(data.spend.covered.allowance))}{/if}
          {#if data.spend.covered.balance}{@render tile(s.anBalance, usd(data.spend.covered.balance))}{/if}
        </div>
        <div class="grid">
          {@render card(s.anSpendDay, spendCharts.days)}
          {@render card(s.anSpendTotal, spendCharts.total)}
          {@render card(s.anModels, spendCharts.models)}
          {@render card(s.anTokens, spendCharts.tokens, undefined, undefined, s.anHint_tokens)}
          {@render card(s.anKeys, spendCharts.keys, undefined, undefined, s.anHint_keys)}
          {@render card(s.anPerMeme, spendCharts.perMeme, undefined, undefined, s.anHint_perMeme)}
        </div>
      {:else if !shared}
        <p class="hint">{s.anEmpty}</p>
      {/if}

      {@render section(s.anEmbeddings, s.anIntro_embeddings)}
      <Embeddings {result} {onOpen} {onTag} readonly={!!shared} />
    {/if}
  </Stack>
{/snippet}

<!-- Porn stats: hidden with "hide porn" and when there is no porn. -->
{#snippet pornSection(p: PornSide)}
  {#if pornCharts}
    {@render section(s.anPorn, s.anIntro_porn)}
    <div class="tiles">
      {@render tile(s.anPornCount, p.porn.toLocaleString())}
      {@render tile(s.anPornShare, `${Math.round((1000 * p.porn) / (p.ready || 1)) / 10}%`)}
      {#if p.comics}{@render tile(s.anPornComics, p.comics.toLocaleString())}{/if}
    </div>
    <div class="grid">
      {@render card(s.anPornShareMonth, pornCharts.share)}
      {@render card(s.anPornMonth, pornCharts.perMonth)}
      {@render card(s.anPornHeat, pornCharts.heat, "300px", undefined, s.anHint_heatmap)}
      {#if pornCharts.tags}{@render card(s.anPornTags, pornCharts.tags, undefined, (c) => onTag(c.name), s.anTagHint)}{/if}
      {#if pornCharts.sources}{@render card(s.anPornSources, pornCharts.sources)}{/if}
    </div>
  {/if}
{/snippet}

<!-- Run state: progress, the start form with the AI choice, adding AI names later. -->
{#snippet controls()}
  {#if loading}
    <Spinner label="Loading" />
  {:else}
    {#if running}
      <section class="card">
        <Stack gap="sm">
          <Heading as="h3" size="sm">{s.anRun}</Heading>
          <Progress value={percent} label={stage} animated />
          <span class="hint">{stage}{run?.total ? ` · ${run.done} / ${run.total}` : ""}</span>
        </Stack>
      </section>
    {:else if run?.status === "failed"}
      <Alert tone="danger" title={s.anFailed}>{run.error}</Alert>
    {/if}
    {#if !result && !running}
      <EmptyState title={s.anRun} description={s.anRunHint} />
    {/if}
    {#if result && ready}
      <ShareLink porn={!!result.analytics?.porn && !me?.hide_porn} bind:link={ready.share} />
      <span class="hint">{fill(s.anComputed, { date: date(ready.created_at), n: result.count, next: date(ready.fresh_until) })}</span>
    {/if}
    {#if canStart}
      <section class="card">
        <Stack gap="sm">
          <Checkbox bind:checked={llm} label={s.anLlm} description={s.anLlmWarn} />
          <div>
            <Button onclick={() => start(llm)} loading={starting}>
              {#snippet leading()}<Sparkles size={16} aria-hidden="true" />{/snippet}
              {result ? s.anRerun : s.anRun}
            </Button>
          </div>
        </Stack>
      </section>
    {:else if ready && !ready.labeled && !running && result?.clusters.length}
      <section class="card">
        <Inline gap="sm" align="center" wrap>
          <Button size="sm" variant="secondary" onclick={() => start(true)} loading={starting}>
            {#snippet leading()}<Sparkles size={16} aria-hidden="true" />{/snippet}
            {s.anAddNames}
          </Button>
          <span class="hint">{s.anLlmWarn}</span>
        </Inline>
      </section>
    {/if}
  {/if}
{/snippet}

{#snippet allUsers()}
  {#if !adminCharts || !admin}
    <Spinner label="Loading" />
  {:else}
    <Stack gap="md">
      <p class="hint">{s.anIntro_admin}</p>
      <div class="grid">
        {@render card(s.anUsers, adminCharts.users)}
        {@render card(s.anUserTable, adminCharts.usersTotal)}
        {@render card(s.anMemesAll, adminCharts.memes)}
        {@render card(s.anSpendDay, adminCharts.spend)}
        {@render card(s.anStatuses, adminCharts.statuses)}
        {@render card(s.anKeys, adminCharts.keys)}
        {#if adminCharts.payments}{@render card(s.anPayments, adminCharts.payments)}{/if}
        {#if adminCharts.errors}{@render card(s.anErrors, adminCharts.errors)}{/if}
      </div>
      <section class="card">
        <Heading as="h4" size="sm">{s.anUserTable}</Heading>
        <div class="scroll">
          <Table label={s.anUserTable} density="compact" striped>
            <thead><tr><th>ID</th><th>@</th><th>{s.anMemes}</th><th>{s.anSpendCol}</th><th>{s.anBotKey}</th></tr></thead>
            <tbody>
              {#each admin.table.users as u (u.id)}
                <tr><td>{u.id}</td><td>{u.username ?? "—"}</td><td>{u.memes}</td><td>{usd(u.total_cost)}</td><td>{usd(u.global)}</td></tr>
              {/each}
            </tbody>
          </Table>
        </div>
      </section>
    </Stack>
  {/if}
{/snippet}

{#snippet section(title: string, intro: string)}
  <header class="section">
    <Heading as="h3" size="md">{title}</Heading>
    <p class="hint">{intro}</p>
  </header>
{/snippet}

{#snippet card(title: string, option: object, height?: string, onclick?: (p: any) => void, hint?: string)}
  <section class="card">
    <Heading as="h4" size="sm">{title}</Heading>
    {#if hint}<p class="hint">{hint}</p>{/if}
    <Chart {option} height={height ?? autoHeight(option)} label={title} {onclick} />
  </section>
{/snippet}

{#snippet tile(label: string, value: string)}
  <div class="tile"><span class="label">{label}</span><span class="value">{value}</span></div>
{/snippet}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: var(--cf-space-2);
  }
  /* The arrow lines up with the content edge: the button's inset around the 1rem icon goes outside. */
  .head > :global(:first-child) {
    margin-inline-start: calc((1rem - var(--cf-control-height-sm)) / 2);
  }
  .head :global(.title) {
    margin: 0;
    line-height: 1.2;
  }
  .panel {
    padding-block: var(--cf-space-3, 0.75rem);
  }
  .section {
    margin-top: var(--cf-space-4);
    border-top: 1px solid var(--cf-color-border);
    padding-top: var(--cf-space-4);
  }
  .section :global(h3) {
    margin: 0 0 var(--cf-space-1);
  }
  .card p.hint,
  .section p.hint {
    margin: 0 0 var(--cf-space-2);
  }
  .grid {
    display: grid;
    align-items: start; /* a short chart does not stretch to its tall neighbour */
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
    gap: var(--cf-space-4, 1rem);
  }
  .card,
  .tile {
    border: 1px solid var(--cf-color-border, rgb(127 127 127 / 0.25));
    border-radius: var(--cf-radius-lg, 12px);
    padding: var(--cf-space-3, 0.75rem);
    min-width: 0;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--cf-space-3, 0.75rem);
    margin-bottom: var(--cf-space-4, 1rem);
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .label,
  .hint {
    color: var(--cf-color-text-muted, #71717a);
    font-size: var(--cf-font-size-sm, 0.875rem);
  }
  .value {
    font-size: var(--cf-font-size-xl, 1.25rem);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .scroll {
    overflow-x: auto;
  }
</style>
