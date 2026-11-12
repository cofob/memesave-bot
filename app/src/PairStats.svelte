<script lang="ts">
  // Two collections side by side: the daily embedding analysis of the pair (map, clusters, moods, picks) and
  // the SQL stats (activity, tags, sources and identical memes).
  import { Alert, Button, Checkbox, EmptyState, Heading, IconButton, Progress, Spinner, Stack } from "@cofob2/design-system-svelte";
  import { ArrowLeft, ArrowRight, Clapperboard, Eye, Sparkles } from "@lucide/svelte";
  import type { EChartsCoreOption } from "echarts/core";
  import { onDestroy, untrack } from "svelte";
  import { api, ApiError, type AnalysisRun, type MemeBrief, type PairFeedMode, type PairResult, type PairStats, type PairView, type PornSide, type SharedParts } from "./api";
  import Chart from "./Chart.svelte";
  import { onLive } from "./live";
  import { autoHeight, bars, heatmap, line, stacked } from "./charts";
  import PairMap, { clusterName } from "./PairMap.svelte";
  import { indexed } from "./search.svelte";
  import ShareLink from "./ShareLink.svelte";
  import Thumbs from "./Thumbs.svelte";
  import { fill, isRu, s } from "./strings";

  interface Props {
    id: string;
    onBack?: () => void;
    onOpen: (id: string, owner?: number) => void; // owner: the partner's user id for their memes
    onView: (who: { id: number; name: string }) => void;
    onFeed: (pair: PairView, mode?: PairFeedMode) => void; // mode: none resumes the last one
    shared?: { result: PairResult; stats: PairStats; names: (string | null)[] }; // a public link: read-only, the sharer is "me"
    parts?: SharedParts; // what the link shares (an old one: regular stats only)
  }
  let { id, onBack, onOpen, onView, onFeed, shared: sharedProp, parts: sharedParts }: Props = $props();
  const shared = untrack(() => sharedProp); // a fixed snapshot
  const parts = shared ? (untrack(() => sharedParts) ?? { normal: true, porn: false }) : { normal: true, porn: true };

  let st = $state.raw<PairStats | null>(shared?.stats ?? null);
  let pair = $state<PairView | null>(null);
  let error = $state(false);
  $effect(() => {
    if (shared) return;
    const want = id;
    Promise.all([api.pairStats(want), api.pairs()]).then(
      ([v, list]) => {
        st = v;
        pair = list.pairs.find((p) => p.id === want) ?? null;
      },
      () => (error = true),
    );
  });

  type Side = PairStats["me"];
  type Count = { k: string | null; n: number };
  const me = shared ? (shared.names[0] ?? s.pairSomeone) : s.pairYou;
  const partner = $derived(st?.partner.name ?? pair?.partner.name ?? s.pairSomeone);

  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(isRu ? "ru" : "en", { weekday: "short" })); // Mon..Sun
  const hours = Array.from({ length: 24 }, (_, h) => String(h));
  const offset = Math.round(new Date().getTimezoneOffset() / 60);
  const local = (h: number) => (h - offset + 24) % 24; // UTC hour → the viewer's hour
  const sum = (rows: { n: number }[]) => rows.reduce((a, r) => a + r.n, 0);
  const pct = (n: number, of: number) => Math.round((1000 * n) / (of || 1)) / 10;
  const kindName = (k: string) => ({ photo: s.statPhotos, video: s.statVideos, animation: s.statGifs })[k] ?? k;

  /** Two lines over a category axis, one per person. */
  const lines = (xs: string[], a: number[], b: number[]) => ({
    legend: { top: 0 },
    tooltip: { trigger: "axis" },
    grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
    xAxis: { type: "category", data: xs, boundaryGap: false },
    yAxis: { type: "value" },
    series: [a, b].map((data, i) => ({ name: i ? partner : me, type: "line", data, showSymbol: false, lineStyle: { width: 2 } })),
  });

  /** Horizontal bars with both values per row (largest first), one series per person. */
  function pairBars(rows: { name: string; me: number; partner: number }[]) {
    const r = [...rows].reverse(); // the axis draws bottom-up
    return {
      legend: { top: 0 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
      xAxis: { type: "value", axisLabel: { show: false }, splitLine: { show: false } },
      yAxis: { type: "category", data: r.map((x) => x.name), axisLabel: { width: 140, overflow: "truncate" } },
      series: [r.map((x) => x.me), r.map((x) => x.partner)].map((data, i) => ({
        name: i ? partner : me,
        type: "bar",
        data,
        barMaxWidth: 10,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
      })),
    };
  }

  /** The share (%) of each key in both collections, e.g. languages. */
  function shares(a: Count[], b: Count[], name: (k: string) => string) {
    const of = (rows: Count[], k: string) => pct(rows.find((r) => (r.k ?? "—") === k)?.n ?? 0, sum(rows));
    const keys = [...new Set([...a, ...b].map((r) => r.k ?? "—"))];
    const rows = keys.map((k) => ({ name: name(k), me: of(a, k), partner: of(b, k) }));
    return pairBars(rows.sort((x, y) => y.me + y.partner - x.me - x.partner).slice(0, 12));
  }

  const heat = (rows: Side["heatmap"], name: string) => heatmap(hours, weekdays, rows.map((c) => [c.h, (c.wd + 6) % 7, c.n] as [number, number, number]), name);
  const byHour = (side: Side) => {
    const v = hours.map(() => 0);
    for (const c of side.heatmap) v[local(c.h)] += c.n;
    return v.map((n) => pct(n, sum(side.heatmap)));
  };
  const part = (x: Side, pick: (c: Side["heatmap"][number]) => boolean) => pct(sum(x.heatmap.filter(pick)), sum(x.heatmap));
  // Client-side badges: who wins each, with both shares.
  const badges = $derived.by(() => {
    if (!st || !parts.normal) return [];
    const rules: [string, (x: Side) => number][] = [
      [s.pairNightOwl, (x) => part(x, (c) => local(c.h) < 6)],
      [s.pairWeekend, (x) => part(x, (c) => c.wd === 0 || c.wd === 6)],
      [s.pairVideo, (x) => pct(sum(x.kinds.filter((r) => r.k === "video")), sum(x.kinds))],
    ];
    return rules.map(([label, f]) => {
      const [a, b] = [f(st!.me), f(st!.partner)];
      return [label, `${a >= b ? me : partner} · ${a}% / ${b}%`];
    });
  });

  const charts = $derived.by(() => {
    if (!st || !parts.normal) return null;
    const months = [...new Set([...st.me.months, ...st.partner.months].map((m) => m.month))].sort();
    const perMonth = (side: Side) => months.map((x) => side.months.find((m) => m.month === x)?.n ?? 0);
    const sh = st.shared;
    return {
      heatMe: heat(st.me.heatmap, st.me.name ?? ""),
      heatPartner: heat(st.partner.heatmap, st.partner.name ?? ""),
      hours: lines(hours, byHour(st.me), byHour(st.partner)),
      months: lines(months, perMonth(st.me), perMonth(st.partner)),
      tags: sh.tags.length ? pairBars(sh.tags.map((t) => ({ name: t.tag, me: t.me, partner: t.partner }))) : null,
      uniqueMe: sh.unique_me.length ? bars(sh.unique_me.map((t) => ({ name: t.tag, value: t.count })), me) : null,
      uniquePartner: sh.unique_partner.length ? bars(sh.unique_partner.map((t) => ({ name: t.tag, value: t.count })), partner) : null,
      sources: sh.sources.length ? pairBars(sh.sources.map((x) => ({ name: x.name, me: x.me, partner: x.partner }))) : null,
      languages: shares(st.me.languages, st.partner.languages, (k) => k.toUpperCase()),
      kinds: shares(st.me.kinds, st.partner.kinds, kindName),
    };
  });
  // The server leaves porn out when a side hides it or nobody has any.
  const pornCharts = $derived.by(() => {
    const p = parts.porn ? st?.porn : null;
    if (!p) return null;
    const months = [...new Set([p.me, p.partner].flatMap((x) => x?.months ?? []).map((m) => m.month))].sort();
    const share = (x: PornSide | null) => months.map((mo) => { const m = x?.months.find((r) => r.month === mo); return m ? pct(m.porn, m.n) : 0; });
    const unique = (x: PornSide | null, y: PornSide | null, name: string) => {
      const top = (x?.tags ?? []).filter((t) => !y?.tags.some((u) => u.tag === t.tag)).slice(0, 10);
      return top.length ? bars(top.map((t) => ({ name: t.tag, value: t.count })), name) : null;
    };
    return {
      ...p,
      share: lines(months, share(p.me), share(p.partner)),
      heatMe: p.me && heat(p.me.heatmap, me),
      heatPartner: p.partner && heat(p.partner.heatmap, partner),
      tags: p.tags.length ? pairBars(p.tags.map((t) => ({ name: t.tag, me: t.me, partner: t.partner }))) : null,
      uniqueMe: unique(p.me, p.partner, me),
      uniquePartner: unique(p.partner, p.me, partner),
    };
  });
  const firstOf = (memeId: string) => {
    const t = st?.shared.twins.items.find((x) => x[0] === memeId);
    return t ? fill(s.pairFirstOf, { name: t[2] <= t[3] ? me : partner }) : "";
  };

  // The embedding analysis: run state as in Analytics, the result and the partner's meme previews.
  let run = $state<AnalysisRun | null>(null);
  let ready = $state<AnalysisRun | null>(null);
  let result = $state.raw<PairResult | null>(shared?.result ?? null);
  let loading = $state(!shared);
  let starting = $state(false);
  let tooSmall = $state(false);
  let llm = $state(true);
  let previews = $state.raw(new Map<string, MemeBrief>());

  async function refresh() {
    try {
      const a = await api.pairAnalysis(id);
      run = a.current;
      if (a.ready && (a.ready.id !== ready?.id || a.ready.labeled !== ready?.labeled)) result = await api.pairAnalysisResult(id);
      ready = a.ready;
    } catch {
      error = true;
    } finally {
      loading = false;
    }
  }

  async function start() {
    starting = true;
    try {
      run = await api.pairAnalysisStart(id, llm);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && e.message.includes("pair_too_small")) tooSmall = true;
      else error = true;
    } finally {
      starting = false;
    }
  }

  if (!shared) refresh();
  // Server push (live.ts) instead of polling: each progress step of the run.
  if (!shared) onDestroy(onLive((e) => void ((e.t === "reconnect" || (e.t === "job" && e.kind === "analysis")) && refresh())));

  const running = $derived(run?.status === "running");
  const canStart = $derived(!running && (!ready || Date.now() / 1000 > ready.fresh_until));
  const percent = $derived(run && run.total ? Math.round((run.done / run.total) * 100) : undefined);
  const stage = $derived((s as unknown as Record<string, string>)[`anStage_${run?.stage ?? "queued"}`] ?? run?.stage ?? "");
  const date = (t: number) => new Date(t * 1000).toLocaleString();

  // Owner 0/1 in the result is owners[0]/owners[1]; `side` is the viewer's one.
  const side = $derived(result && st ? Math.max(0, result.owners.indexOf(st.me.id)) : 0);
  const nameOf = (o: number) => (o === side ? me : partner);
  const ownerOf = $derived(new Map(result?.memes.map((m) => [m[0], m[4]]) ?? []));
  const theirs = (memeId: string) => ownerOf.get(memeId) === 1 - side;
  const facts = $derived(result?.facts?.[isRu ? "ru" : "en"] ?? Object.values(result?.facts ?? {})[0]);
  const brief = (memeId: string) => previews.get(memeId) ?? indexed(memeId);
  // A partner's meme opens only with its preview loaded (they still share).
  const open = (memeId: string) => (!theirs(memeId) ? onOpen(memeId) : previews.has(memeId) && onOpen(memeId, result!.owners[1 - side]));

  /** The result from the viewer's side: pairs as [mine, theirs], clusters as shared / only mine / only theirs. */
  const pick = $derived.by(() => {
    if (!result) return null;
    const [o, p] = [side, 1 - side];
    const mineFirst = (t: [string, string, number]) => [t[o], t[p], t[2]] as [string, string, number];
    return {
      clusters: ["shared", o ? "b" : "a", o ? "a" : "b"].map((type) => result!.clusters.filter((c) => c.type === type)),
      twins: result.twins.slice(0, 30).map(mineFirst),
      rhymes: result.rhymes.map(mineFirst),
      forMe: result.for[o],
      forThem: result.for[p],
      surprise: result.surprise[o],
    };
  });

  // The partner's previews of the shown memes (≤100 per request); on 403 the thumbnails stay empty.
  $effect(() => {
    if (!result || !pick) return;
    const shown = [...pick.clusters.flat().flatMap((c) => c.sample.slice(0, 6)), ...pick.twins.map((t) => t[1]), ...pick.rhymes.map((t) => t[1]), ...pick.forMe, ...pick.surprise, ...result.bridge];
    const ids = [...new Set(shown)].filter(theirs);
    const owner = result.owners[1 - side];
    const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, (i + 1) * 100));
    Promise.all(chunks.map((c) => api.pairMemes(owner, c))).then(
      (r) => (previews = new Map(r.flatMap((x) => x.items.map((m) => [m.id, m] as const)))),
      () => {},
    );
  });

  const moodCharts = $derived.by(() => {
    const md = result?.moods;
    if (!md) return null;
    const names = md.names[isRu ? "ru" : "en"] ?? md.names.en ?? md.keys;
    const label = md.keys.map((_, k) => `${md.emoji[k]} ${names[k]}`);
    const overall = [md.overall[side], md.overall[1 - side]];
    const total = label.map((_, k) => (overall[0]?.[k] ?? 0) + (overall[1]?.[k] ?? 0));
    const order = label.map((l, k) => [l, total[k]] as const).sort((a, b) => b[1] - a[1]).map(([l]) => l); // same colors in both charts
    const pct = (v: number) => `${Math.round(v)}%`;
    const perMonth = (rows: (number[] | null)[]) =>
      stacked(md.months.flatMap((month, m) => (rows[m] ?? []).map((v, k) => ({ month, k: label[k], v: v * 100 }))), (r) => r.month, (r) => r.k, (r) => r.v, { xs: md.months, order, fmt: pct });
    const max = Math.max(1, ...overall.flatMap((v) => v ?? []).map((x) => x * 100));
    return {
      radar: {
        legend: { top: 0 },
        tooltip: { trigger: "item" },
        radar: { indicator: label.map((name) => ({ name, max })), radius: "62%", center: ["50%", "56%"] },
        series: [{ type: "radar", data: overall.flatMap((v, i) => (v ? [{ name: i ? partner : me, value: v.map((x) => Math.round(x * 1000) / 10) }] : [])) }],
      },
      me: perMonth([md.a, md.b][side]),
      partner: perMonth([md.a, md.b][1 - side]),
      sim: line(md.months, md.sim.map((v) => (v == null ? NaN : Math.round(v * 100))), s.pairMoodSim, pct),
      top: [md.top[side], md.top[1 - side]].map((k) => label[k] ?? "—"),
      best: md.best.join(", "),
    };
  });
  const syncChart = $derived(result?.sync.months.length ? line(result.sync.months, result.sync.sim, s.pairSyncLine, (v) => v.toFixed(2)) : null);
</script>

<Stack gap="md">
  <div class="head">
    {#if onBack}<IconButton label={s.pairBackList} variant="ghost" size="sm" onclick={onBack}><ArrowLeft size={18} /></IconButton>{/if}
    <Heading as="h2" size="md" class="title">{s.pairStats}</Heading>
  </div>
  {#if error}<Alert tone="danger" title={s.error} />{/if}

  {#if !st || !charts}
    {#if st && !parts.normal}
      <section class="hero"><span class="names">{me} & {partner}</span></section>
      {@render pornSection()}
    {:else if !error}<Spinner label="Loading" />{/if}
  {:else}
    {@const sh = st.shared}
    <section class="hero">
      <span class="names">{me} & {partner}</span>
      <span class="compat">{result?.scores.compat ?? st.compat}%</span>
      <span class="hint">{s.pairCompat} · {result ? s.pairCompatFull : s.pairCompatHint}</span>
      {#if facts}<strong>{facts.title}</strong><span>{facts.verdict}</span>{/if}
      {#if pair?.they_share && st.partner.id}
        <Button size="sm" variant="secondary" onclick={() => onView({ id: st!.partner.id, name: partner })}>
          {#snippet leading()}<Eye size={16} aria-hidden="true" />{/snippet}
          {fill(s.pairView, { name: partner })}
        </Button>
      {/if}
      {#if pair}
        {@const p = pair}
        <div class="feeds">
          <Button size="sm" onclick={() => onFeed(p)}>
            {#snippet leading()}<Clapperboard size={16} aria-hidden="true" />{/snippet}
            {s.pairFeed}
          </Button>
          {#if p.they_share}<Button size="sm" variant="secondary" onclick={() => onFeed(p, "guess")}>{s.pairGuess}</Button>{/if}
          {#if pick?.forMe.length}<Button size="sm" variant="secondary" onclick={() => onFeed(p, "foryou")}>{fill(s.pairForYou, { name: partner })}</Button>{/if}
        </div>
      {/if}
    </section>
    <div class="tiles">
      {@render tile(fill(s.pairMemesOf, { name: me }), st.me.ready.toLocaleString())}
      {@render tile(fill(s.pairMemesOf, { name: partner }), st.partner.ready.toLocaleString())}
      {@render tile(s.pairJaccard, `${Math.round(sh.jaccard * 100)}%`)}
      {@render tile(s.pairHourSim, `${Math.round(sh.hourSim * 100)}%`)}
      {@render tile(s.pairMonthSim, sh.monthSim.toFixed(2))}
      {@render tile(s.pairTwins, sh.twins.count.toLocaleString())}
    </div>
    <div class="tiles">
      {#each badges as [label, value] (label)}{@render tile(label, value)}{/each}
    </div>

    {#if !shared}{@render controls()}{/if}
    {#if result && pick}
      {@const sc = result.scores}
      <div class="tiles">
        {@render tile(s.pairMixing, `${Math.round(sc.mixing * 100)}%`)}
        {@render tile(s.pairCentroid, sc.centroid.toFixed(2))}
        {#if result.moods}{@render tile(s.pairMoodSim, `${Math.round(sc.moodSim * 100)}%`)}{/if}
      </div>

      {#if facts}
        {@render section(s.pairFacts, s.pairFactsIntro)}
        <ul class="facts">
          {#each facts.facts as f, i (i)}<li>{f}</li>{/each}
        </ul>
        <div class="tiles">
          {#each facts.awards as a, i (i)}
            <div class="tile">
              <span class="label">{a.name}</span>
              <span class="value">{a.winner === "both" ? s.pairBoth : nameOf(a.winner === "a" ? 0 : 1)}</span>
              <span class="hint">{a.reason}</span>
            </div>
          {/each}
        </div>
      {/if}

      {@render section(s.pairMap, s.pairMapIntro)}
      <PairMap {result} {side} names={[me, partner]} {brief} onOpen={open} />

      {#if result.clusters.length}
        {@render section(s.pairClusters, s.pairClustersIntro)}
        {#each [s.pairSharedClusters, fill(s.pairUniqueOf, { name: me }), fill(s.pairUniqueOf, { name: partner })] as title, g (g)}
          {#if pick.clusters[g].length}
            <Heading as="h4" size="sm">{title}</Heading>
            <div class="grid">
              {#each pick.clusters[g] as c (c.id)}
                <article class="card">
                  <Stack gap="xs">
                    <strong>{clusterName(c)}</strong>
                    <span class="hint">{me} {c.share[side]} · {partner} {c.share[1 - side]}{c.summary ? ` · ${c.summary}` : ""}</span>
                    <span class="hint">{c.tags.slice(0, 6).map((t) => `#${t}`).join(" ")}</span>
                    <Thumbs ids={c.sample.slice(0, 6)} onOpen={open} items={previews} />
                  </Stack>
                </article>
              {/each}
            </div>
          {/if}
        {/each}
      {/if}

      {@render pairs(s.pairNear, s.pairNearIntro, pick.twins)}
      {@render pairs(s.pairRhymes, s.pairRhymesIntro, pick.rhymes)}

      {#if !shared}
        {@render section(s.pairPicks, s.pairPicksIntro)}
        <div class="grid">
          {@render gallery(fill(s.pairForYou, { name: partner }), pick.forMe)}
          {@render gallery(fill(s.pairForThem, { name: partner }), pick.forThem)}
          {@render gallery(fill(s.pairSurprise, { name: partner }), pick.surprise)}
        </div>
      {/if}
      {#if result.bridge.length}
        <section class="card">
          <Heading as="h4" size="sm">{s.pairBridge}</Heading>
          <p class="hint">{s.pairBridgeHint}</p>
          <div class="chain">
            {#each result.bridge as b, i (b)}
              {#if i}<ArrowRight size={16} aria-hidden="true" />{/if}
              <div class="link"><Thumbs ids={[b]} onOpen={open} items={previews} note={(x) => nameOf(ownerOf.get(x) ?? 0)} /></div>
            {/each}
          </div>
        </section>
      {/if}

      {#if moodCharts}
        {@render section(s.pairMoods, s.pairMoodsIntro)}
        <div class="tiles">
          {@render tile(fill(s.pairMoodYear, { name: me }), moodCharts.top[0])}
          {@render tile(fill(s.pairMoodYear, { name: partner }), moodCharts.top[1])}
          {#if moodCharts.best}{@render tile(s.pairBestMonths, moodCharts.best)}{/if}
        </div>
        <div class="grid">
          {@render card(s.pairMoodRadar, moodCharts.radar, "380px")}
          {@render card(s.pairMoodSimLine, moodCharts.sim)}
          {@render card(fill(s.pairMoodMonths, { name: me }), moodCharts.me)}
          {@render card(fill(s.pairMoodMonths, { name: partner }), moodCharts.partner)}
        </div>
      {/if}

      {@render section(s.pairSync, s.pairSyncIntro)}
      <div class="tiles">
        {#each [side, 1 - side] as o (o)}{@render tile(fill(s.pairInfluenceOf, { name: nameOf(o) }), String(result.influence.score[o]))}{/each}
      </div>
      {#if syncChart}<div class="grid">{@render card(s.pairSyncLine, syncChart, undefined, s.pairSyncHint)}</div>{/if}
    {/if}

    {@render section(s.pairActivity, s.pairActivityIntro)}
    <div class="grid">
      {@render card(fill(s.pairHeatOf, { name: me }), charts.heatMe, "300px")}
      {@render card(fill(s.pairHeatOf, { name: partner }), charts.heatPartner, "300px")}
      {@render card(s.pairHours, charts.hours, undefined, s.pairHoursHint)}
      {@render card(s.pairMonths, charts.months)}
    </div>

    {@render section(s.pairTags, s.pairTagsIntro)}
    <div class="grid">
      {#if charts.tags}{@render card(s.pairSharedTags, charts.tags)}{/if}
      {#if charts.uniqueMe}{@render card(fill(s.pairUniqueOf, { name: me }), charts.uniqueMe)}{/if}
      {#if charts.uniquePartner}{@render card(fill(s.pairUniqueOf, { name: partner }), charts.uniquePartner)}{/if}
    </div>

    {#if charts.sources}
      {@render section(s.pairSources, s.pairSourcesIntro)}
      <div class="grid">{@render card(s.pairSources, charts.sources)}</div>
    {/if}

    {#if sh.twins.count}
      {@render section(s.pairTwins, s.pairTwinsIntro)}
      <div class="tiles">
        {@render tile(fill(s.pairFirstOf, { name: me }), sh.twins.first.me.toLocaleString())}
        {@render tile(fill(s.pairFirstOf, { name: partner }), sh.twins.first.partner.toLocaleString())}
      </div>
      {#if sh.twins.items.length}
        <section class="card">
          <Heading as="h4" size="sm">{s.pairFirst}</Heading>
          <Thumbs ids={sh.twins.items.map((t) => t[0])} {onOpen} note={firstOf} />
        </section>
      {/if}
    {/if}

    {@render pornSection()}

    {@render section(s.pairMore, s.pairMoreIntro)}
    <div class="grid">
      {@render card(s.anLanguages, charts.languages)}
      {@render card(s.anKinds, charts.kinds)}
    </div>
  {/if}
</Stack>

{#snippet section(title: string, intro: string)}
  <header class="section">
    <Heading as="h3" size="md">{title}</Heading>
    <p class="hint">{intro}</p>
  </header>
{/snippet}

{#snippet pornSection()}
  {#if pornCharts}
    {@const p = pornCharts}
    {@render section(s.pairPorn, s.pairPornIntro)}
    <div class="tiles">
      {@render tile(fill(s.pairPornShareOf, { name: me }), `${p.me ? pct(p.me.porn, p.me.ready) : 0}%`)}
      {@render tile(fill(s.pairPornShareOf, { name: partner }), `${p.partner ? pct(p.partner.porn, p.partner.ready) : 0}%`)}
      {@render tile(s.pairPornJaccard, `${Math.round(p.jaccard * 100)}%`)}
      {@render tile(s.pairPornTwins, p.twins.count.toLocaleString())}
      {#if p.twins.count}
        {@render tile(fill(s.pairFirstOf, { name: me }), p.twins.first.me.toLocaleString())}
        {@render tile(fill(s.pairFirstOf, { name: partner }), p.twins.first.partner.toLocaleString())}
      {/if}
    </div>
    <div class="grid">
      {@render card(s.anPornShareMonth, p.share)}
      {#if p.heatMe}{@render card(fill(s.pairHeatOf, { name: me }), p.heatMe, "300px")}{/if}
      {#if p.heatPartner}{@render card(fill(s.pairHeatOf, { name: partner }), p.heatPartner, "300px")}{/if}
      {#if p.tags}{@render card(s.pairPornTags, p.tags)}{/if}
      {#if p.uniqueMe}{@render card(fill(s.pairUniqueOf, { name: me }), p.uniqueMe)}{/if}
      {#if p.uniquePartner}{@render card(fill(s.pairUniqueOf, { name: partner }), p.uniquePartner)}{/if}
    </div>
  {/if}
{/snippet}

{#snippet card(title: string, option: EChartsCoreOption, height?: string, hint?: string)}
  <section class="card">
    <Heading as="h4" size="sm">{title}</Heading>
    {#if hint}<p class="hint">{hint}</p>{/if}
    <Chart {option} height={height ?? autoHeight(option)} label={title} />
  </section>
{/snippet}

{#snippet tile(label: string, value: string)}
  <div class="tile"><span class="label">{label}</span><span class="value">{value}</span></div>
{/snippet}

<!-- Run state of the analysis: progress, the start form with the AI choice. -->
{#snippet controls()}
  {#if !loading}
    {#if running}
      <section class="card">
        <Stack gap="sm">
          <Heading as="h3" size="sm">{s.pairRun}</Heading>
          <Progress value={percent} label={stage} animated />
          <span class="hint">{stage}{run?.total ? ` · ${run.done} / ${run.total}` : ""}</span>
        </Stack>
      </section>
    {:else if run?.status === "failed"}
      <Alert tone="danger" title={s.anFailed}>{run.error}</Alert>
    {/if}
    {#if tooSmall}<Alert tone="info" title={s.pairTooSmall} />{/if}
    {#if !result && !running}<EmptyState title={s.pairRun} description={s.pairRunHint} />{/if}
    {#if result && ready}
      <ShareLink pair={id} porn={!!st?.porn} bind:link={ready.share} />
      <span class="hint">{fill(s.anComputed, { date: date(ready.created_at), n: result.count[0] + result.count[1], next: date(ready.fresh_until) })}</span>
    {/if}
    {#if canStart}
      <section class="card">
        <Stack gap="sm">
          <Checkbox bind:checked={llm} label={s.pairLlm} description={s.anLlmWarn} />
          <div>
            <Button onclick={start} loading={starting}>
              {#snippet leading()}<Sparkles size={16} aria-hidden="true" />{/snippet}
              {result ? s.anRerun : s.pairRun}
            </Button>
          </div>
        </Stack>
      </section>
    {/if}
  {/if}
{/snippet}

<!-- Meme pairs side by side, mine first. -->
{#snippet pairs(title: string, intro: string, list: [string, string, number][])}
  {#if list.length}
    {@render section(title, intro)}
    <div class="pairs">
      {#each list as [a, b, sim] (a + b)}
        <div>
          <Thumbs ids={[a, b]} onOpen={open} items={previews} />
          <span class="hint">{fill(s.anSimilar, { sim: sim.toFixed(3) })}</span>
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet gallery(title: string, ids: string[])}
  {#if ids.length}
    <section class="card">
      <Heading as="h4" size="sm">{title}</Heading>
      <Thumbs {ids} onOpen={open} items={previews} />
    </section>
  {/if}
{/snippet}

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
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--cf-space-2);
    text-align: center;
  }
  .feeds {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--cf-space-2);
  }
  .names {
    font-size: var(--cf-font-size-lg);
    font-weight: 600;
  }
  .compat {
    font-size: var(--cf-font-size-5xl);
    font-weight: 700;
    line-height: 1;
    color: var(--cf-color-accent);
    font-variant-numeric: tabular-nums;
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
    align-items: start;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
    gap: var(--cf-space-4);
  }
  .hero,
  .card,
  .tile {
    border: 1px solid var(--cf-color-border);
    border-radius: var(--cf-radius-lg);
    padding: var(--cf-space-3);
    min-width: 0;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--cf-space-3);
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .label,
  .hint {
    color: var(--cf-color-text-muted);
    font-size: var(--cf-font-size-sm);
  }
  .value {
    font-size: var(--cf-font-size-xl);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .facts {
    margin: 0;
    padding-inline-start: var(--cf-space-4);
  }
  .pairs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--cf-space-3);
  }
  .chain {
    display: flex;
    align-items: center;
    gap: var(--cf-space-2);
    overflow-x: auto;
  }
  .link {
    flex: 0 0 88px;
  }
</style>
