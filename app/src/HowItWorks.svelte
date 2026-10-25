<script lang="ts">
  import { Badge, Card, Heading, IconButton, Inline, MediaGrid, Stack, Stepper, Tag, Text, TextField } from "@cofob2/design-system-svelte";
  import { Pause, Play, Search, X } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { flip } from "svelte/animate";
  import { demo, type DemoMeme } from "./demo";
  import { findIds, makeIndex } from "./search.svelte";
  import { fill, s } from "./strings";

  type Step = "forward" | "describe" | "find";
  const steps = [
    { id: "forward", label: s.howStep1, text: s.howStep1Text },
    { id: "describe", label: s.howStep2, text: s.howStep2Text },
    { id: "find", label: s.howStep3, text: s.howStep3Text },
  ];

  // The same client index and query rules as the app's instant search.
  const index = makeIndex(demo);
  const byId = new Map(demo.map((m) => [m.id, m]));
  const kindLabel = (m: DemoMeme) => (m.kind === "photo" ? s.f_kind_photo : m.kind === "video" ? s.video : s.gif);
  const hashtags = (m: DemoMeme) => m.tags.map((t) => "#" + t.replace(/[^\p{L}\p{N}_]+/gu, "_")).join(" ");
  const sections = (m: DemoMeme) =>
    [
      [s.text, m.ocr_text],
      [s.speech, m.speech_text],
      [s.description, m.description],
      [s.meaning, m.cultural_meaning],
    ].filter(([, value]) => value);

  const DONE = 99; // phase of a fully shown step
  let step = $state<Step>("forward");
  let current = $state(0); // the meme of this round
  let phase = $state(0);
  let query = $state("");
  let playing = $state(!matchMedia("(prefers-reduced-motion: reduce)").matches);
  let visible = false;
  let root = $state<HTMLElement>();

  // Newest first: the meme of this round was just saved.
  const library = $derived([demo[current]!, ...demo.filter((_, i) => i !== current)]);
  const results = $derived(query.trim() ? findIds(index, query.trim()).map((id) => byId.get(id)!) : library);
  const slots = $derived(demo.map((_, i) => results[i] ?? null));

  // Autoplay: one round per meme; a newer run() or halt() stops the older one at its next wait.
  let run = 0;
  const halt = () => run++;
  async function loop() {
    const id = ++run;
    const wait = (ms: number) => new Promise<void>((ok, stop) => setTimeout(() => (id === run ? ok() : stop()), ms));
    try {
      for (;;) {
        step = "forward";
        query = "";
        phase = 0;
        for (const ms of [500, 900, 1800]) {
          await wait(ms);
          phase++; // the forwarded meme, the bot reply, the edited reply
        }
        await wait(2600);
        step = "describe";
        phase = 0;
        for (const ms of [1000, ...sections(demo[current]!).map(() => 600)]) {
          await wait(ms);
          phase++; // title and tags, then one section per phase
        }
        await wait(3000);
        step = "find";
        await wait(800);
        for (const ch of demo[current]!.query) {
          query += ch;
          await wait(140);
        }
        await wait(3200);
        current = (current + 1) % demo.length;
      }
    } catch {
      // stopped
    }
  }

  function pause() {
    playing = false;
    halt();
  }

  function toggle() {
    playing = !playing;
    if (playing && visible) loop();
    else halt();
  }

  function show(next: Step, i = current) {
    pause();
    step = next;
    current = i;
    phase = DONE;
    query = next === "find" ? demo[i]!.query : "";
  }

  onMount(() => {
    if (!playing) phase = DONE;
    // Plays only on screen.
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = !!entry?.isIntersecting;
        if (visible && playing) loop();
        else halt();
      },
      { threshold: 0.4 },
    );
    observer.observe(root!);
    return () => {
      observer.disconnect();
      halt();
    };
  });
</script>

<!-- Every step of every meme is in one grid cell: the box keeps the height of the tallest one. -->

{#snippet chat(m: DemoMeme, p: number)}
  <div class="chat">
    <div class="bubble out reveal" class:on={p >= 1}>
      <span class="fwd">{fill(s.howForwardedFrom, { from: m.from })}</span>
      <img src={m.img} alt={m.title} />
      <span class="meta">12:00</span>
    </div>
    <div class="bubble in reveal" class:on={p >= 2}>
      <span class="quote"><b>{s.howYou}</b>{kindLabel(m)}</span>
      <span class="swap">
        <span class:gone={p >= 3}>{s.howBotSaving}</span>
        <span class:gone={p < 3}>✅ <b>{m.title}</b><br /><span class="hashtags">{hashtags(m)}</span></span>
      </span>
      <span class="meta">{p >= 3 ? `${s.howEdited} ` : ""}12:00</span>
    </div>
  </div>
{/snippet}

{#snippet detail(m: DemoMeme, p: number)}
  {@const list = sections(m)}
  <div class="sheet">
    <div class="sheet-head">
      <span class="swap">
        <span class:gone={p >= 1}><Heading level={3} size="md">{kindLabel(m)}</Heading></span>
        <span class:gone={p < 1}><Heading level={3} size="md">{m.title}</Heading></span>
      </span>
      <X size={18} aria-hidden="true" />
    </div>
    <div class="sheet-body">
      <div class="stage"><img class:moving={m.kind !== "photo"} src={m.img} alt={m.title} /></div>
      <Stack gap="md" class="info">
        <span class:gone={p >= 1 + list.length}><Text tone="muted" size="sm">{s.processing}</Text></span>
        <div class="reveal" class:on={p >= 1}>
          <Inline gap="xs" wrap>
            {#each m.tags as t (t)}<Tag>#{t}</Tag>{/each}
          </Inline>
        </div>
        {#each list as [label, value], k (label)}
          <div class="reveal" class:on={p >= 2 + k}>
            <Stack gap="xs">
              <Heading as="h3" size="sm">{label}</Heading>
              <Text class="pre">{value}</Text>
            </Stack>
          </div>
        {/each}
      </Stack>
    </div>
  </div>
{/snippet}

<Card padding="lg">
  <div bind:this={root}>
    <Stack gap="md">
      <Inline gap="sm" align="center">
        <Heading level={2} size="lg">{s.howTitle}</Heading>
        <span class="spacer"></span>
        <IconButton label={playing ? s.howPause : s.howPlay} variant="ghost" size="sm" onclick={toggle}>
          {#if playing}<Pause size={16} />{:else}<Play size={16} />{/if}
        </IconButton>
      </Inline>
      <Stepper items={steps} currentStep={step} label={s.howTitle} onStepChange={(id) => show(id as Step)} />

      <div class="layers">
        {#each steps as st (st.id)}
          <div class="layer" class:on={step === st.id} aria-hidden={step !== st.id}><Text tone="muted">{st.text}</Text></div>
        {/each}
      </div>

      <div class="layers">
        {#each demo as m, i (m.id)}
          {@const on = step === "forward" && i === current}
          <div class="layer" class:on inert={!on}>{@render chat(m, on ? phase : DONE)}</div>
        {/each}
        {#each demo as m, i (m.id)}
          {@const on = step === "describe" && i === current}
          <div class="layer" class:on inert={!on}>{@render detail(m, on ? phase : DONE)}</div>
        {/each}
        <div class="layer" class:on={step === "find"} inert={step !== "find"}>
          <Stack gap="md">
            <TextField type="search" bind:value={query} placeholder={s.search} aria-label={s.search} onfocus={pause}>
              {#snippet leading()}<Search size={16} aria-hidden="true" />{/snippet}
            </TextField>
            <span class="hint" class:gone={!query.trim()}>{s.aiHint}</span>
            <div class="results">
              <MediaGrid class="demo-grid">
                {#each slots as m, k (m?.id ?? `slot${k}`)}
                  <li class:empty={!m} animate:flip={{ duration: 300 }}>
                    {#if m}
                      <button class="tile" onclick={() => show("describe", demo.indexOf(m))} aria-label={m.title}>
                        <img src={m.img} alt={m.title} />
                        {#if m.kind !== "photo"}
                          <Badge class="kind" size="sm" variant="solid">{m.kind === "video" ? s.video : s.gif}</Badge>
                        {/if}
                      </button>
                    {/if}
                  </li>
                {/each}
              </MediaGrid>
              {#if !results.length}<span class="none">{s.noResults}</span>{/if}
            </div>
          </Stack>
        </div>
      </div>
    </Stack>
  </div>
</Card>

<style>
  .spacer {
    flex: 1;
  }
  .layers,
  .swap {
    display: grid;
  }
  .layers > *,
  .swap > * {
    grid-area: 1 / 1;
  }
  .layer {
    display: grid;
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 0.3s,
      visibility 0s 0.3s;
  }
  .layer.on {
    opacity: 1;
    visibility: visible;
    transition: opacity 0.3s;
  }
  .gone {
    visibility: hidden;
  }
  /* Hidden items keep their space; they only fade in. */
  .reveal {
    opacity: 0;
    visibility: hidden;
    transform: translateY(0.4rem);
  }
  .reveal.on {
    opacity: 1;
    visibility: visible;
    transform: none;
    transition:
      opacity 0.35s ease-out,
      transform 0.35s ease-out;
  }

  /* Step 1: the bot chat. */
  .chat {
    display: grid;
    align-content: end; /* messages stick to the bottom, as in Telegram */
    gap: var(--cf-space-2);
    padding: var(--cf-space-3);
    border-radius: var(--cf-radius-lg);
    background: var(--cf-color-chat-canvas);
  }
  .bubble {
    display: grid;
    gap: var(--cf-space-1);
    max-inline-size: 85%;
    padding: var(--cf-space-2);
    border-radius: var(--cf-radius-lg);
    font-size: var(--cf-font-size-sm);
  }
  .out {
    justify-self: end;
    background: var(--cf-color-accent-soft);
    border-end-end-radius: var(--cf-radius-sm);
  }
  .in {
    justify-self: start;
    background: var(--cf-color-surface-raised);
    border-end-start-radius: var(--cf-radius-sm);
  }
  .out img {
    inline-size: 11rem;
    max-inline-size: 100%;
    aspect-ratio: 1;
    border-radius: var(--cf-radius-md);
  }
  .fwd {
    color: var(--cf-color-accent);
    font-size: var(--cf-font-size-xs);
  }
  .quote {
    display: grid;
    padding-inline-start: var(--cf-space-2);
    border-inline-start: 3px solid var(--cf-color-accent);
    font-size: var(--cf-font-size-xs);
    color: var(--cf-color-text-muted);
  }
  .quote b {
    color: var(--cf-color-accent);
  }
  .hashtags {
    color: var(--cf-color-accent);
  }
  .meta {
    justify-self: end;
    font-size: var(--cf-font-size-xs);
    color: var(--cf-color-text-muted);
  }

  /* Step 2: the meme sheet of the app. */
  .sheet {
    border: 1px solid var(--cf-color-border);
    border-radius: var(--cf-radius-lg);
    overflow: hidden;
  }
  .sheet-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--cf-space-2);
    padding: var(--cf-space-3);
    border-block-end: 1px solid var(--cf-color-border);
    color: var(--cf-color-text-muted);
  }
  .sheet-body {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    gap: var(--cf-space-4);
    padding: var(--cf-space-3);
  }
  .stage {
    display: grid;
    place-items: center;
    flex: 0 0 11rem;
    aspect-ratio: 1;
    background: #09090b;
    border-radius: var(--cf-radius-lg);
    overflow: hidden;
  }
  .stage img {
    inline-size: 100%;
  }
  .moving {
    animation: wobble 1.6s ease-in-out infinite;
  }
  @keyframes wobble {
    50% {
      transform: scale(1.05) rotate(-2deg);
    }
  }
  .sheet-body :global(.info) {
    flex: 1 1 14rem;
  }
  .sheet-body :global(.pre) {
    white-space: pre-line;
  }

  /* Step 3: the search of the app. */
  .hint {
    color: var(--cf-color-text-muted);
    font-size: var(--cf-font-size-xs);
  }
  .results {
    position: relative;
  }
  :global(.demo-grid.cf-media-grid) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--cf-space-1-5);
  }
  .results li {
    aspect-ratio: 1;
  }
  .results li.empty {
    visibility: hidden;
  }
  .tile {
    all: unset;
    cursor: pointer;
    display: block;
    position: relative;
    inline-size: 100%;
    block-size: 100%;
  }
  .tile img {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
  }
  .tile :global(.kind) {
    position: absolute;
    inset-block-end: var(--cf-space-1);
    inset-inline-start: var(--cf-space-1);
  }
  .none {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--cf-color-text-muted);
  }

  @media (prefers-reduced-motion: reduce) {
    .layer,
    .layer.on,
    .reveal.on {
      transition: none;
    }
    .moving {
      animation: none;
    }
  }
</style>
