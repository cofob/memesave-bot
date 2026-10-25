// Usage: BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://memereserve.cfb.wtf bun run setup
export {};
const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL) throw new Error("Set BOT_TOKEN, WEBHOOK_SECRET and WORKER_URL");

const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: `${WORKER_URL.replace(/\/$/, "")}/webhook`,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "inline_query", "callback_query", "pre_checkout_query", "subscription"],
    drop_pending_updates: true,
  }),
});
console.log(await res.json());
