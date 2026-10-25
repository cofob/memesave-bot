# memesave-bot
Save your memes in telegram bot

## Setup

```sh
bun install
bunx wrangler d1 create memesave            # put database_id into wrangler.jsonc
bunx wrangler vectorize create memesave-memes --dimensions=1536 --metric=cosine
bunx wrangler queues create memesave-jobs
bunx wrangler queues create memesave-dlq
bunx wrangler r2 bucket create memesave-media   # permanent copies of all media
bunx wrangler r2 bucket lifecycle add memesave-media tmp-7d tmp/ --expire-days 7
bunx wrangler kv namespace create OAUTH_KV  # MCP OAuth grants: put id into kv_namespaces in wrangler.jsonc
bunx wrangler secret put BOT_TOKEN
bunx wrangler secret put WEBHOOK_SECRET
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put ENCRYPTION_KEY     # random string, encrypts users' OpenRouter keys
bunx wrangler secret put TG_CLIENT_SECRET   # BotFather → Login Widget → Client Secret (web login)
bunx wrangler secret put R2_ACCESS_KEY_ID      # R2 API token (Object Read, memesave-media): presigned links
bunx wrangler secret put R2_SECRET_ACCESS_KEY  # for batch images, which Vertex fetches outside Workers
bun run migrate:remote
bun run deploy
BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://memereserve.cfb.wtf bun run setup
```

Set your domain in `PUBLIC_URL` and `routes` in `wrangler.jsonc` (the zone must be in the same Cloudflare account). It is used for the webhook and the OpenRouter OAuth callback.

Enable inline mode in @BotFather (`/setinline`). Bot commands are set automatically.

MCP server for AI apps: `<PUBLIC_URL>/mcp` (OAuth with Telegram login; connections are managed in Account → Settings).

HTTP API for scripts: `<PUBLIC_URL>/app/api/*` with `Authorization: Bearer <token>` (Account → Settings → API tokens), described in `<PUBLIC_URL>/openapi.json`. `tiktok-sync/` imports liked TikToks through it.
