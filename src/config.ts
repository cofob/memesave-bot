export const MODELS = {
  embed: "google/gemini-embedding-2",
  describeImage: "google/gemini-4-argon",
  describeVideo: "google/gemini-3.8-flash", // video + animation
  search: "deepseek/deepseek-v4.1-flash-1017",
};
export const EMBED_DIMS = 1536; // Vectorize max
export const VIDEO_INLINE_MAX_BYTES = 15 * 1024 * 1024; // base64 grows x1.33
export const MIN_VECTOR_SCORE = 0.2;
export const RRF_K = 60;
export const INLINE_LIMIT = 50;
export const INLINE_CACHE_SECONDS = 600;
export const CHAT_LIMIT = 10;
export const AGENT_INITIAL = 20;
export const AGENT_MAX_STEPS = 6;
export const AGENT_MAX_VIEWS = 12;
export const FAST_LLM_TIMEOUT_MS = 3500;
export const MAX_JOB_ATTEMPTS = 3;
export const MAX_BUSY_ATTEMPTS = 10; // rate limits and busy D1 retry longer, with backoff (queue max_retries is 10)

// Billing for the "paid" role. Prices in USD; Telegram Stars at STAR_USD, rounded up to 10⭐.
export const STAR_USD = 0.013;
export const PLANS = {
  monthly: { usd: 1, byokUsd: 0.5, days: 30 },
  yearly: { usd: 10, byokUsd: 4, days: 360 }, // 12 allowance months of 30 days
} as const;
export const MONTHLY_ALLOWANCE = 0.5; // USD of AI spend per 30-day month on standard (not own-key) plans
export const STAR_TOPUPS = [100, 250, 500, 1000];
export const CRYPTO_TOPUPS = [5, 10, 25, 50]; // USD: on-chain fees make small amounts pointless
export const CRYPTO_INVOICES_PER_HOUR = 5; // per user: each USDT invoice holds an address of the BTCPay pool
export const LOW_BALANCE = 0.1;
export const DESCRIBE_MODELS = { max: "google/gemini-4-argon", medium: "openai/gpt-6-luna" } as const; // photos
// Tier of new accounts. The DB column default stays "max" (SQLite cannot change it), so inserts set it.
export const DEFAULT_TIER = "medium";
export const DESCRIBE_FALLBACKS = ["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017"]; // photos a provider blocks
export const DESCRIBE_VIDEO_FALLBACKS = ["google/gemini-4-argon", "qwen/qwen3.8-omni-flash"]; // video + audio input

// MCP: OAuth scopes and the request body limit (base64 of a 10 MB photo).
export const MCP_SCOPES = { read: "memes:read", write: "memes:write" } as const;
export const MCP_BODY_MAX = 16 << 20;
