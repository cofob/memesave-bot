import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, BOT_TOKEN: "1:test", WEBHOOK_SECRET: "s", OPENROUTER_API_KEY: "k", ENCRYPTION_KEY: "e", TG_CLIENT_SECRET: "cs" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
