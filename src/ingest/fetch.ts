import type { Env } from "../env";
import { proxyFetch } from "../thumb";

const TRIES = 3;

/** Did the site block us (Cloudflare challenge, rate limit, geo block)? */
async function blocked(res: Response): Promise<boolean> {
  if ([403, 429, 503].includes(res.status) || res.headers.get("cf-mitigated") === "challenge") return true;
  return !!res.headers.get("content-type")?.includes("text/html") && (await res.clone().text()).includes("Just a moment");
}

/**
 * fetch(), and when the site blocks us a retry through a random proxy of FETCH_PROXIES (up to 3, the next one
 * on a failure). Without proxies the direct result is returned as is.
 */
export async function fetchPage(env: Env, url: string, init: RequestInit = {}, userId?: number): Promise<Response> {
  let last: Response | undefined;
  let error: unknown;
  try {
    last = await fetch(url, init);
    if (!(await blocked(last))) return last;
  } catch (e) {
    error = e;
  }
  const proxies = (env.FETCH_PROXIES ?? "").split(",").map((p) => p.trim()).filter(Boolean).sort(() => Math.random() - 0.5);
  const req = { url, method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: typeof init.body === "string" ? init.body : undefined };
  for (const proxy of proxies.slice(0, TRIES)) {
    try {
      const res = await proxyFetch(env, userId, { ...req, proxy });
      last = res;
      // 502: the container could not reach the site through this proxy
      if (res.status !== 502 && !(await blocked(res))) return res;
    } catch (e) {
      error = e;
    }
  }
  if (last) return last;
  throw error;
}

/** Media download: same as fetchPage (the HTML check skips non-HTML bodies). */
export const fetchMedia = fetchPage;
