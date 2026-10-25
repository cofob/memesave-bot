import { EMBED_DIMS, MODELS } from "./config";
import type { Env } from "./env";
import { recordSpend, type Spend } from "./spend";
import { apiKey, keyFor } from "./userkey";

const BASE = "https://openrouter.ai/api/v1";

export type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// reasoning_details must be sent back unchanged for tool calling with reasoning models.
export type AssistantMessage = { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown[] };

export type ChatMessage =
  | { role: "system" | "user"; content: string | Part[] }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

async function post(env: Env, path: string, body: { model: string } & Record<string, unknown>, spend: Spend, signal?: AbortSignal) {
  const { key, source } = await apiKey(env, spend.userId);
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/cofob/memesave-bot",
      "X-Title": "memesave-bot",
    },
    body: JSON.stringify({ ...body, user: String(spend.userId) }),
    signal,
  });
  const data = await res.json<any>().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`OpenRouter ${path} ${res.status} (${source} key): ${JSON.stringify(data.error ?? data).slice(0, 500)}`);
  }
  await recordSpend(env, spend, body.model, source, data.usage ?? {});
  return data;
}

export async function chat(
  env: Env,
  body: { model: string; messages: ChatMessage[] } & Record<string, unknown>,
  spend: Spend,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  const data = await post(env, "/chat/completions", body, spend, signal);
  return data.choices[0].message;
}

export type EmbedInput = string | { content: Part[] };

export async function embed(
  env: Env,
  input: EmbedInput[],
  inputType: "search_document" | "search_query",
  spend: Spend,
): Promise<number[][]> {
  const data = await post(
    env,
    "/embeddings",
    { model: MODELS.embed, input, input_type: inputType, dimensions: EMBED_DIMS },
    spend,
  );
  return (data.data as { index: number; embedding: number[] }[])
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export type KeySource = "global" | "user";

export interface Batch {
  id: string;
  status: "validating" | "in_progress" | "finalizing" | "completed" | "failed" | "expired" | "cancelled";
  usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
  request_counts?: { total: number; completed: number; failed: number };
  error?: { message?: string } | null;
  results?: { custom_id: string; response?: any; error?: { message?: string } | unknown }[] | null;
}

async function batchFetch(key: string, path: string, init: RequestInit = {}): Promise<Batch> {
  const res = await fetch(`https://openrouter.ai/api/v1/batches${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "memesave-bot" },
  });
  const data = await res.json<any>().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter batches ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 500)}`);
  return data;
}

/** Submits a batch with the user's current key. `requests` goes last: OpenRouter requires it. */
export async function createBatch(env: Env, userId: number, head: Record<string, unknown>, requests: unknown[]) {
  const { key, source } = await apiKey(env, userId);
  const batch = await batchFetch(key, "", { method: "POST", body: JSON.stringify({ ...head, requests }) });
  return { batch, source };
}

/** Reads a batch with the same key source that submitted it. */
export async function getBatch(env: Env, userId: number, source: KeySource, id: string) {
  return batchFetch(await keyFor(env, userId, source), `/${encodeURIComponent(id)}`);
}
