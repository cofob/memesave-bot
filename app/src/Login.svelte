<script lang="ts">
  import { Alert, Card, Container, Heading, Stack, Text } from "@cofob2/design-system-svelte";
  import { LogIn } from "@lucide/svelte";
  import { s } from "./strings";

  const error = new URLSearchParams(location.search).get("error");
</script>

<Container size="narrow" class="login">
  <Card padding="lg">
    <Stack gap="md">
      <Heading level={1} size="xl">{s.loginTitle}</Heading>
      <Text tone="muted">{s.loginText}</Text>
      {#if error}
        <Alert tone="danger" title={error === "no_access" ? s.loginNoAccess : s.loginFailed} />
      {/if}
      <a class="cf-button" data-size="lg" href="/auth/telegram">
        <LogIn size={18} aria-hidden="true" />
        <span class="cf-button__label">{s.loginButton}</span>
      </a>
    </Stack>
  </Card>
</Container>

<style>
  :global(.login) {
    padding-block: 15vh;
  }
</style>
