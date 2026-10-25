<script lang="ts">
  import {
    Alert,
    Badge,
    Button,
    Container,
    Drawer,
    EmptyState,
    IconButton,
    Inline,
    MediaGrid,
    Select,
    Spinner,
    Stack,
    Tag,
    TextField,
  } from "@cofob2/design-system-svelte";
  import { Bot, CircleUser, LogOut, Search, SlidersHorizontal, Sparkles, Tags, Upload } from "@lucide/svelte";
  import { onMount, untrack } from "svelte";
  import { api, ApiError, type Me, type MemeBrief, type Sort } from "./api";
  import Account from "./Account.svelte";
  import FilterDrawer from "./FilterDrawer.svelte";
  import { activeCount, emptyFilters, groups, matches, toQuery, type Filters } from "./filters";
  import Login from "./Login.svelte";
  import MemeDetail from "./MemeDetail.svelte";
  import { s } from "./strings";
  import { syncTheme, tg } from "./telegram";
  import UploadPanel from "./UploadPanel.svelte";
  import { addFiles, onUploadReady } from "./uploads.svelte";
  import { forget, loadIndex, localSearch, textIndex } from "./search.svelte";

  // "login": web without a session; "denied": the account has no access.
  let auth = $state<"checking" | "ok" | "login" | "denied">("checking");
  let me = $state<Me | null>(null);
  let accountOpen = $state(false);
  // Result of the OpenRouter connect redirect (?key=connected|failed), shown once.
  let notice = $state<{ tone: "success" | "danger"; text: string } | null>(null);
  let fileInput = $state<HTMLInputElement>();
  let dragging = $state(false);

  let query = $state("");
  let sort = $state<Sort>("new");
  let tag = $state<string | null>(null);
  let filters = $state<Filters>(emptyFilters());
  let filtersOpen = $state(false);
  let items = $state<MemeBrief[]>([]);
  let nextOffset = $state<number | null>(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let tagsOpen = $state(false);
  let tagList = $state<{ tag: string; count: number }[] | null>(null);
  let selected = $state<string | null>(null);
  let sentinel = $state<HTMLElement>();
  let generation = 0; // drops answers of outdated requests

  const searching = $derived(query.trim().length > 0);

  // Search: the client index answers instantly; after a short pause the inline-mode search
  // (server FTS + embeddings + LLM query rewrite) refines it; the agent runs on demand.
  let mode = $state<"quick" | "advanced">("quick");
  let serverItems = $state<MemeBrief[] | null>(null);
  let aiItems = $state<MemeBrief[] | null>(null);
  let aiLoading = $state(false);
  let searchGen = 0;
  let ftsTimer: ReturnType<typeof setTimeout>;

  const localItems = $derived(textIndex.version >= 0 && searching ? localSearch(query.trim()) : []);
  const textItems = $derived.by(() => {
    const server = serverItems ?? [];
    const seen = new Set(server.map((m) => m.id));
    return [...server, ...localItems.filter((m) => !seen.has(m.id))];
  });
  // The server filters the list; search results are filtered here with the same rules.
  const shown = $derived(
    !searching ? items : (mode === "quick" ? textItems : (aiItems ?? [])).filter((m) => matches(m, filters)),
  );
  const noResults = $derived(
    searching && (mode === "quick" ? serverItems !== null && textItems.length === 0 : !aiLoading && aiItems !== null && aiItems.length === 0),
  );

  async function serverSearch(q: string, gen: number) {
    const page = await api.search(q, "fast").catch(() => null);
    if (page && gen === searchGen) serverItems = page.items;
  }

  $effect(() => {
    const q = query.trim();
    if (auth !== "ok") return;
    mode = "quick";
    aiItems = null;
    serverItems = null;
    const gen = ++searchGen;
    clearTimeout(ftsTimer);
    if (q.length >= 2) ftsTimer = setTimeout(() => serverSearch(q, gen), 400);
  });

  function searchNow() {
    const q = query.trim();
    if (q.length < 2 || mode !== "quick" || serverItems) return;
    clearTimeout(ftsTimer);
    serverSearch(q, searchGen);
  }

  async function runAdvanced() {
    const q = query.trim();
    if (q.length < 2) return;
    const gen = searchGen;
    mode = "advanced";
    aiItems = null;
    aiLoading = true;
    try {
      const page = await api.search(q, "advanced");
      if (gen === searchGen && mode === "advanced") aiItems = page.items;
    } catch {
      if (gen === searchGen) tg?.showAlert(s.error);
    } finally {
      if (gen === searchGen) aiLoading = false;
    }
  }
  const sortOptions = [
    { value: "new", label: s.sortNew },
    { value: "old", label: s.sortOld },
    { value: "title", label: s.sortTitle },
  ];

  const nearEnd = () => !searching && nextOffset !== null && !!sentinel && sentinel.getBoundingClientRect().top < innerHeight + 600;

  async function load(reset: boolean) {
    if (loading && !reset) return;
    if (!reset && nextOffset === null) return;
    const gen = reset ? ++generation : generation;
    loading = true;
    error = null;
    try {
      const page = await api.list(sort, tag, reset ? 0 : (nextOffset ?? 0), toQuery(filters));
      if (gen !== generation) return;
      items = reset ? page.items : [...items, ...page.items];
      nextOffset = page.next_offset;
      // The observer fires only when the sentinel starts intersecting: if the page is still
      // shorter than the screen, load the next one right away.
      requestAnimationFrame(() => {
        if (gen === generation && nearEnd()) load(false);
      });
    } catch (e) {
      if (gen === generation) error = String(e).includes("403") ? s.noAccess : s.error;
    } finally {
      if (gen === generation) loading = false;
    }
  }

  // Reload the list when the filters change.
  $effect(() => {
    if (auth !== "ok") return;
    void [sort, tag, JSON.stringify(filters)];
    // untrack: load() reads `loading`/`nextOffset`; tracking them would reload page 1 after every load.
    untrack(() => load(true));
  });

  $effect(() => {
    if (auth === "ok") untrack(() => loadIndex().catch(() => {}));
  });

  async function openTags() {
    tagsOpen = true;
    tagList ??= await api.tags().catch(() => []);
  }

  function pickTag(value: string | null) {
    tag = value;
    query = "";
    tagsOpen = false;
    selected = null;
  }

  async function logout() {
    await api.logout();
    auth = "login";
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    if (auth === "ok" && event.dataTransfer?.files.length) addFiles(event.dataTransfer.files);
  }

  onMount(() => {
    tg?.ready();
    tg?.expand();
    syncTheme();
    const key = new URLSearchParams(location.search).get("key");
    if (key) {
      notice = key === "connected" ? { tone: "success", text: s.keyConnected } : { tone: "danger", text: s.keyFailed };
      history.replaceState(null, "", location.pathname);
    }
    api.me().then(
      (value) => {
        me = value;
        auth = "ok";
      },
      (e) => (auth = e instanceof ApiError && e.status === 403 ? (tg ? "denied" : "login") : "denied"),
    );
    // New uploads: add to the search index and show at the top of the default view.
    return onUploadReady(() => {
      loadIndex().catch(() => {});
      if (sort === "new" && !tag) load(true);
    });
  });

  // Infinite scroll: the sentinel exists only after login.
  $effect(() => {
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && !searching && load(false), {
      rootMargin: "600px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  });
</script>

<svelte:window
  ondragover={(e) => {
    if (auth !== "ok") return;
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={(e) => !e.relatedTarget && (dragging = false)}
  ondrop={onDrop}
/>

{#if auth === "login"}
  <Login />
{:else if auth === "denied"}
  <Container size="narrow" class="app"><Alert tone="danger" title={s.noAccess} /></Container>
{:else if auth === "checking"}
  <div class="sentinel"><Spinner label="Loading" /></div>
{:else}

<Container size="default" class="app">
  <Stack gap="md">
    <TextField
      type="search"
      bind:value={query}
      placeholder={s.search}
      aria-label={s.search}
      enterkeyhint="search"
      onkeydown={(e) => e.key === "Enter" && searchNow()}
    >
      {#snippet leading()}<Search size={16} aria-hidden="true" />{/snippet}
    </TextField>

    {#if searching}
      <Stack gap="xs">
        <Inline gap="sm" align="center" wrap>
          <Button
            size="sm"
            variant={mode === "advanced" ? "primary" : "secondary"}
            loading={aiLoading}
            onclick={runAdvanced}
            disabled={query.trim().length < 2}
          >
            {#snippet leading()}<Bot size={16} aria-hidden="true" />{/snippet}
            {s.aiAdvanced}
          </Button>
          {#if mode === "advanced"}
            <Button size="sm" variant="ghost" onclick={() => (mode = "quick")}>
              {#snippet leading()}<Sparkles size={16} aria-hidden="true" />{/snippet}
              {s.quickResults}
            </Button>
          {/if}
        </Inline>
        <span class="hint">{mode === "quick" ? s.aiHint : s.aiResults}</span>
      </Stack>
    {/if}

    <Inline gap="sm" align="center" wrap>
      <Select bind:value={sort} options={sortOptions} aria-label={s.sort} size="sm" disabled={searching} />
      <Button variant="secondary" size="sm" onclick={openTags} disabled={searching}>
        {#snippet leading()}<Tags size={16} aria-hidden="true" />{/snippet}
        {s.tags}
      </Button>
      <Button variant={activeCount(filters) ? "primary" : "secondary"} size="sm" onclick={() => (filtersOpen = true)}>
        {#snippet leading()}<SlidersHorizontal size={16} aria-hidden="true" />{/snippet}
        {s.filters}{#if activeCount(filters)}&nbsp;· {activeCount(filters)}{/if}
      </Button>
      {#if tag && !searching}
        <Tag tone="accent" removable removeLabel={s.allTags} onRemove={() => pickTag(null)}>#{tag}</Tag>
      {/if}
      {#each groups as g (g)}
        {#each filters[g] as v (v)}
          <Tag
            tone="accent"
            removable
            removeLabel={s.filtersReset}
            onRemove={() => (filters = { ...filters, [g]: filters[g].filter((x) => x !== v) })}
            >{g === "lang" ? v.toUpperCase() : ((s as Record<string, string>)[`f_${g}_${v}`] ?? v)}</Tag
          >
        {/each}
      {/each}
      {#if filters.added}
        <Tag tone="accent" removable removeLabel={s.filtersReset} onRemove={() => (filters = { ...filters, added: "" })}
          >{(s as Record<string, string>)[`f_added_${filters.added}`]}</Tag
        >
      {/if}
      <span class="spacer"></span>
      <Button size="sm" onclick={() => fileInput?.click()}>
        {#snippet leading()}<Upload size={16} aria-hidden="true" />{/snippet}
        {s.upload}
      </Button>
      <IconButton label={s.account} variant="ghost" size="sm" onclick={() => (accountOpen = true)}><CircleUser size={18} /></IconButton>
      {#if !tg}
        <IconButton label={s.logout} variant="ghost" size="sm" onclick={logout}><LogOut size={16} /></IconButton>
      {/if}
    </Inline>
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*,video/*,.zip,application/zip"
      multiple
      hidden
      onchange={(e) => {
        addFiles(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
      }}
    />

    {#if notice}
      <Alert tone={notice.tone} title={notice.text} dismissible onDismiss={() => (notice = null)} />
    {/if}
    {#if error}
      <Alert tone="danger" title={error}>
        <Button size="sm" variant="secondary" onclick={() => load(true)}>{s.retry}</Button>
      </Alert>
    {:else if noResults}
      <EmptyState title={s.noResults} description={s.noResultsHint} />
    {:else if !searching && !loading && items.length === 0}
      <EmptyState title={activeCount(filters) ? s.noResults : s.empty} description={activeCount(filters) ? s.filtersEmpty : s.emptyHint} />
    {/if}

    <MediaGrid class="grid">
      {#each shown as meme (meme.id)}
        <li>
          <button class="tile" onclick={() => (selected = meme.id)} aria-label={meme.title ?? meme.id}>
            <img src={meme.thumb} alt={meme.title ?? ""} loading="lazy" />
            {#if meme.status === "failed"}
              <Badge class="kind" size="sm" variant="solid" tone="danger">{s.stateError}</Badge>
            {:else if meme.status !== "ready"}
              <Badge class="kind" size="sm" variant="solid" tone="info">{s.processing}</Badge>
            {:else if meme.kind !== "photo"}
              <Badge class="kind" size="sm" variant="solid">{meme.kind === "video" ? s.video : s.gif}</Badge>
            {/if}
          </button>
        </li>
      {/each}
    </MediaGrid>

    <div bind:this={sentinel} class="sentinel">
      {#if (loading && !searching) || aiLoading}<Spinner label="Loading" />{/if}
    </div>
  </Stack>
</Container>

<Drawer open={tagsOpen} title={s.tags} side="bottom" closeLabel={s.close} onOpenChange={(open) => (tagsOpen = open)}>
  {#if tagList === null}
    <Spinner label="Loading" />
  {:else if tagList.length === 0}
    <EmptyState title={s.noTags} />
  {:else}
    <Inline gap="xs" wrap>
      {#each tagList as t (t.tag)}
        <button class="tag-button" onclick={() => pickTag(t.tag)}>
          <Tag tone={t.tag === tag ? "accent" : undefined}>#{t.tag} · {t.count}</Tag>
        </button>
      {/each}
    </Inline>
  {/if}
</Drawer>

<UploadPanel />
<FilterDrawer open={filtersOpen} {filters} onChange={(f) => (filters = f)} onClose={() => (filtersOpen = false)} />
{#if me}
  <Account {me} open={accountOpen} onClose={() => (accountOpen = false)} onMeChange={(value) => (me = value)} />
{/if}
{#if dragging}<div class="drop" aria-hidden="true">{s.dropHint}</div>{/if}

{#if selected}
  <MemeDetail
    id={selected}
    onClose={() => (selected = null)}
    onTag={pickTag}
    onRetried={(id) => {
      items = items.map((m) => (m.id === id ? { ...m, status: "embedding" } : m));
      selected = null;
    }}
    onDeleted={(id) => {
      items = items.filter((m) => m.id !== id);
      serverItems = serverItems?.filter((m) => m.id !== id) ?? null;
      aiItems = aiItems?.filter((m) => m.id !== id) ?? null;
      forget(id);
      selected = null;
    }}
  />
{/if}
{/if}

<style>
  :global(body) {
    background: var(--cf-color-canvas);
  }
  :global(.app) {
    padding-block: var(--cf-space-3) var(--cf-space-8);
  }
  :global(.grid.cf-media-grid) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--cf-space-1-5);
  }
  .tile {
    all: unset;
    cursor: pointer;
    display: block;
    position: relative;
    inline-size: 100%;
    aspect-ratio: 1;
  }
  .tile img {
    inline-size: 100%;
    block-size: 100%;
    max-block-size: none;
    object-fit: cover;
  }
  .tile :global(.kind) {
    position: absolute;
    inset-block-end: var(--cf-space-1);
    inset-inline-start: var(--cf-space-1);
  }
  .tag-button {
    all: unset;
    cursor: pointer;
  }
  .hint {
    color: var(--cf-color-text-muted);
    font-size: var(--cf-font-size-xs);
  }
  .spacer {
    flex: 1;
  }
  .drop {
    position: fixed;
    inset: var(--cf-space-3);
    display: grid;
    place-items: center;
    border: 2px dashed var(--cf-color-accent);
    border-radius: var(--cf-radius-xl);
    background: color-mix(in srgb, var(--cf-color-accent-soft) 85%, transparent);
    color: var(--cf-color-accent);
    font-weight: var(--cf-font-weight-semibold);
    pointer-events: none;
    z-index: var(--cf-z-dialog);
  }
  .sentinel {
    display: grid;
    place-items: center;
    min-block-size: 3rem;
  }
</style>
