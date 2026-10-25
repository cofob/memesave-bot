<script lang="ts">
  import { Alert, Card, Container, Heading, Inline, Stack, Text } from "@cofob2/design-system-svelte";
  import { Bot, LogIn } from "@lucide/svelte";
  import { MONTHLY_ALLOWANCE, PLANS } from "../../src/config";
  import { fill, s } from "./strings";

  const error = new URLSearchParams(location.search).get("error");
  const price = (usd: number) => `$${usd}`;
  const features = [s.landingFeat1, s.landingFeat2, s.landingFeat3, s.landingFeat4];
</script>

<Container size="narrow" class="login">
  <Stack gap="lg">
    <Card padding="lg">
      <Stack gap="md">
        <Heading level={1} size="xl">{s.loginTitle}</Heading>
        <Text tone="muted">{s.landingTagline}</Text>
        {#if error}
          <Alert tone="danger" title={error === "no_access" ? s.loginNoAccess : s.loginFailed} />
        {/if}
        <Inline gap="sm" wrap>
          <a class="cf-button" data-size="lg" href="/bot">
            <Bot size={18} aria-hidden="true" />
            <span class="cf-button__label">{s.landingOpenBot}</span>
          </a>
          <a class="cf-button" data-variant="secondary" data-size="lg" href="/auth/telegram">
            <LogIn size={18} aria-hidden="true" />
            <span class="cf-button__label">{s.loginButton}</span>
          </a>
        </Inline>
      </Stack>
    </Card>

    <ul class="features">
      {#each features as f (f)}<li><Text>{f}</Text></li>{/each}
    </ul>

    <Card padding="lg">
      <Stack gap="sm">
        <Heading level={2} size="lg">{s.landingPricing}</Heading>
        <Text>{fill(s.landingPlan, { month: price(PLANS.monthly.usd), year: price(PLANS.yearly.usd) })}</Text>
        <Text tone="muted">{fill(s.billIncludedHint, { allowance: price(MONTHLY_ALLOWANCE) })}</Text>
        <Text tone="muted">{fill(s.landingByok, { month: price(PLANS.monthly.byokUsd), year: price(PLANS.yearly.byokUsd) })}</Text>
        <Text tone="muted">{s.landingPay}</Text>
      </Stack>
    </Card>
  </Stack>
</Container>

<style>
  :global(.login) {
    padding-block: 10vh;
  }
  .features {
    display: grid;
    gap: var(--cf-space-2);
    margin: 0;
    padding-inline-start: var(--cf-space-5);
  }
</style>
