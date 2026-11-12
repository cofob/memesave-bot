import { decrypt } from "../../userkey";
import type { Env } from "../../env";
import { scraperFetch } from "../scraper";

// The e621 API of the account sync (src/e621.ts); the links (posts, pools) are listed by the scraper. API: https://e621.net/wiki_pages/2425

const API = "https://e621.net";
const UA = "memesave/1.0 (e621 importer)"; // generic: never user data

interface Variant {
  url?: string | null;
  size?: number;
}
export interface Post {
  id: number;
  rating: "s" | "q" | "e";
  file: Variant & { ext: string };
  sample: { url: string | null; alternates?: { samples?: Record<string, Variant>; variants?: { mp4?: Variant } } };
  tags: Record<string, string[]>;
  pools: number[];
}
export interface Pool {
  id: number;
  name: string;
  category: "series" | "collection";
  post_ids: number[];
}

export class E621Error extends Error {
  constructor(readonly status: number) {
    super(`e621 ${status}`); // "429" in the message makes the queue back off
  }
}

export const basic = (username: string, apiKey: string) => `Basic ${btoa(`${username}:${apiKey}`)}`;

/** Authorization header of the user's connected e621 account, if any. */
export async function e621Auth(env: Env, userId?: number) {
  const acc = userId ? await env.DB.prepare("SELECT username, api_key FROM e621_accounts WHERE user_id = ?").bind(userId).first<{ username: string; api_key: string }>() : null;
  return acc ? basic(acc.username, await decrypt(env.ENCRYPTION_KEY, acc.api_key)) : undefined;
}

/** GET of the e621 API as JSON, through the scraper (it keeps 2 requests per second, the e621 limit). */
export async function e621Get<T>(env: Env, path: string, auth?: string): Promise<T> {
  const res = await scraperFetch(env, API + path, { headers: { "User-Agent": UA, ...(auth && { Authorization: auth }) } });
  if (!res.ok) {
    console.warn("e621", res.status, path, (await res.text()).slice(0, 300));
    throw new E621Error(res.status);
  }
  return res.json<T>();
}
