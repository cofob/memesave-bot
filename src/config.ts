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
export const UPLOAD_GAP_MS = 3100; // between silent uploads: under ~20 messages/min per chat
export const CHAT_LIMIT = 10;
export const AGENT_INITIAL = 20;
export const AGENT_MAX_STEPS = 6;
export const AGENT_MAX_VIEWS = 12;
export const FAST_LLM_TIMEOUT_MS = 3500;
export const MAX_JOB_ATTEMPTS = 3;
export const MAX_MEMES = 25_000; // per user
export const MAX_BYTES = 30 * 2 ** 30; // per user, sum of file_size
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

// Pair analysis mood anchors when the LLM is off or fails (src/moods.ts): phrases of the emotional tone, en + ru.
export const DEFAULT_MOODS = [
  { key: "absurd", emoji: "🤪", name_en: "Absurd", name_ru: "Абсурд", phrases: ["surreal nonsense that makes no sense", "random absurd humor", "weird bizarre joke", "сюрреалистичный бред", "абсурдный юмор без смысла", "странная нелепая шутка"] },
  { key: "sarcasm", emoji: "😏", name_en: "Sarcasm", name_ru: "Сарказм", phrases: ["dry sarcastic irony", "mocking passive-aggressive joke", "ironic eye-roll", "сухая саркастичная ирония", "язвительная насмешка", "ирония с закатыванием глаз"] },
  { key: "dark", emoji: "💀", name_en: "Dark humor", name_ru: "Чёрный юмор", phrases: ["dark humor about death and misery", "grim morbid joke", "edgy black comedy", "чёрный юмор про смерть", "мрачная жестокая шутка", "циничная чернуха"] },
  { key: "cute", emoji: "🥺", name_en: "Cute", name_ru: "Милота", phrases: ["adorable cute animals", "sweet wholesome cuteness", "aww so cute", "милые животные", "умилительная милота", "няшный котик"] },
  { key: "cringe", emoji: "😬", name_en: "Cringe", name_ru: "Кринж", phrases: ["awkward cringe moment", "embarrassing secondhand shame", "cringeworthy situation", "неловкий кринж", "испанский стыд", "позорная ситуация"] },
  { key: "sad", emoji: "😢", name_en: "Sad", name_ru: "Грусть", phrases: ["sad lonely melancholy", "depressing heartbreak", "crying inside", "грусть и одиночество", "тоска и меланхолия", "плачу внутри"] },
  { key: "rant", emoji: "😤", name_en: "Rant", name_ru: "Злость", phrases: ["angry rant about everything", "furious annoyed outrage", "frustrated yelling", "злой рант обо всём", "бешенство и раздражение", "крик от бессилия"] },
  { key: "nostalgia", emoji: "📼", name_en: "Nostalgia", name_ru: "Ностальгия", phrases: ["nostalgic childhood memories", "the good old days", "retro throwback", "ностальгия по детству", "старые добрые времена", "ретро из прошлого"] },
  { key: "cozy", emoji: "☕", name_en: "Cozy", name_ru: "Уют", phrases: ["cozy calm comfort", "warm relaxing evening", "peaceful chill vibe", "уютное спокойствие", "тёплый вечер дома", "расслабленный вайб"] },
  { key: "chaos", emoji: "🔥", name_en: "Chaos", name_ru: "Хаос", phrases: ["total chaos and mayhem", "unhinged energy", "everything is on fire", "полный хаос", "безумная энергия", "всё горит"] },
  { key: "wholesome", emoji: "🤗", name_en: "Wholesome", name_ru: "Поддержка", phrases: ["wholesome support and kindness", "you are loved encouragement", "heartwarming friendship", "добрая поддержка", "ты молодец, тебя любят", "тёплая дружба"] },
  { key: "self", emoji: "🙃", name_en: "Self-irony", name_ru: "Самоирония", phrases: ["self-deprecating humor about my life", "laughing at my own failures", "me being a mess", "самоирония про свою жизнь", "смеюсь над своими провалами", "я опять всё испортил"] },
];
