import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// One build serves the web version and the Telegram Mini App at /.
export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  plugins: [svelte()],
  build: { outDir: "dist", emptyOutDir: true },
});
