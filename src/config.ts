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
