<script lang="ts">
  import { Button, Drawer, Inline, Stack, Tag } from "@cofob2/design-system-svelte";
  import { api } from "./api";
  import { emptyFilters, groups, type Filters, type Group } from "./filters";
  import { s } from "./strings";

  interface Props {
    open: boolean;
    filters: Filters;
    onChange: (filters: Filters) => void;
    onClose: () => void;
  }
  let { open, filters, onChange, onClose }: Props = $props();

  let facets = $state<{ counts: Record<string, number>; languages: { value: string; count: number }[] } | null>(null);
  $effect(() => {
    if (open) api.facets().then((f) => (facets = f), () => {});
  });

  const options: Record<Exclude<Group, "lang">, string[]> = {
    kind: ["photo", "video", "animation"],
    status: ["ready", "processing", "failed"],
    orient: ["landscape", "portrait", "square"],
    text: ["yes", "no"],
    dur: ["short", "medium", "long"],
  };
  const values = (g: Group) => (g === "lang" ? (facets?.languages.map((l) => l.value) ?? []) : options[g]);
  const count = (g: Group, v: string) =>
    g === "lang" ? facets?.languages.find((l) => l.value === v)?.count : facets?.counts[`${g}:${v}`];
  const label = (g: Group, v: string) => (g === "lang" ? v.toUpperCase() : ((s as unknown as Record<string, string>)[`f_${g}_${v}`] ?? v));

  function toggle(g: Group, v: string) {
    const on = filters[g].includes(v);
    onChange({ ...filters, [g]: on ? filters[g].filter((x) => x !== v) : [...filters[g], v] });
  }
  const added = [
    { value: "", label: s.f_added_any },
    { value: "1", label: s.f_added_1 },
    { value: "7", label: s.f_added_7 },
    { value: "30", label: s.f_added_30 },
  ];
</script>

<Drawer {open} title={s.filters} side="bottom" closeLabel={s.close} onOpenChange={(o) => !o && onClose()}>
  <Stack gap="md">
    {#each groups as g (g)}
      {#if values(g).length}
        <section class="group">
          <h3>{(s as unknown as Record<string, string>)[`f_${g}`]}</h3>
          <Inline gap="xs" wrap>
            {#each values(g) as v (v)}
              <button class="chip" aria-pressed={filters[g].includes(v)} onclick={() => toggle(g, v)}>
                <Tag tone={filters[g].includes(v) ? "accent" : undefined}>
                  {label(g, v)}{#if count(g, v) !== undefined}<span class="n">{count(g, v)}</span>{/if}
                </Tag>
              </button>
            {/each}
          </Inline>
        </section>
      {/if}
    {/each}
    <section class="group">
      <h3>{s.f_added}</h3>
      <Inline gap="xs" wrap>
        {#each added as a (a.value)}
          <button class="chip" aria-pressed={filters.added === a.value} onclick={() => onChange({ ...filters, added: a.value })}>
            <Tag tone={filters.added === a.value ? "accent" : undefined}>{a.label}</Tag>
          </button>
        {/each}
      </Inline>
    </section>
  </Stack>
  {#snippet footer()}
    <Inline gap="sm">
      <Button variant="secondary" onclick={() => onChange(emptyFilters())}>{s.filtersReset}</Button>
      <Button onclick={onClose}>{s.filtersDone}</Button>
    </Inline>
  {/snippet}
</Drawer>

<style>
  .group h3 {
    margin: 0 0 var(--cf-space-1-5);
    font-size: var(--cf-font-size-sm);
    color: var(--cf-color-text-muted);
    font-weight: var(--cf-font-weight-semibold);
  }
  .chip {
    all: unset;
    cursor: pointer;
  }
  .chip:focus-visible {
    outline: 2px solid var(--cf-color-focus);
    border-radius: var(--cf-radius-full);
  }
  .n {
    margin-inline-start: var(--cf-space-1-5);
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
</style>
