import { EMBED_DIMS, MODELS } from "./config";
import type { Env } from "./env";
import { esc } from "./i18n";
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

/** An OpenRouter error; `reason` is safe to show to the user. */
export class OpenRouterError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

/** The error as HTML for a bot message: OpenRouter errors only, other errors are internal. */
export const errorNote = (e: unknown) => (e instanceof OpenRouterError ? `\n<code>${esc(e.reason)}</code>` : "");

/** Parses the body; a non-JSON body (e.g. an HTML 502 page) becomes an error. */
async function parse(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 200) || res.statusText || "empty response" } };
  }
}

function fail(path: string, status: number, error: any, source?: KeySource): never {
  const raw = error?.metadata?.raw;
  const reason = [error?.message ?? JSON.stringify(error), error?.metadata?.provider_name, typeof raw === "string" ? raw : raw && JSON.stringify(raw)]
    .filter(Boolean)
    .join(" — ");
  const key = source ? ` (${source} key)` : "";
  throw new OpenRouterError(`OpenRouter ${path} ${status}${key}: ${JSON.stringify(error).slice(0, 500)}`, `OpenRouter ${status}: ${reason.slice(0, 300)}`);
}

/** Rate limits and provider errors: worth one more try. */
const transient = (status: number) => status === 408 || status === 429 || status >= 500;

async function post(env: Env, path: string, body: { model: string } & Record<string, unknown>, spend: Spend, signal?: AbortSignal, retries = 1) {
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
  const data = await parse(res);
  // A provider error can also come with status 200, inside the choice.
  const error = data.error ?? data.choices?.[0]?.error ?? (!res.ok && data);
  if (error) {
    const status = Number(error.code) || res.status;
    if (retries > 0 && transient(status) && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 1000));
      return post(env, path, body, spend, signal, retries - 1);
    }
    fail(path, status, error, source);
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
  const message = data.choices?.[0]?.message;
  if (!message) fail("/chat/completions", 502, { message: "no message in response" });
  return message;
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
  const data = await parse(res);
  if (!res.ok) fail("batches", res.status, data.error ?? data);
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
