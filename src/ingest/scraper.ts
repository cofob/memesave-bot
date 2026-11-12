import type { Env } from "../env";
import { LIMITS } from "../webapp";
import type { GallerySource, Item, Listing } from "./gallery";
import { e621Auth } from "./sources/e621";

// The gallery sites (Telegraph, e621, Hentoid sites) are in the scraper service (scraper/, SCRAPER_URL): the site
// logic, proxies and Cloudflare challenges. POST / lists a gallery, POST /media downloads an item, POST /fetch a request.

/** A failed site request; "429" in the message makes the queue back off. */
export class ScraperError extends Error {
  constructor(
    readonly status: number,
    readonly code = "upstream",
  ) {
    super(`scraper ${code} ${status}`);
  }
}

/** POST of JSON to the scraper. */
export const scraperCall = (env: Env, path: string, body: unknown) =>
  fetch(new URL(path, env.SCRAPER_URL), { method: "POST", headers: { Authorization: `Api-Key ${env.SCRAPER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** A request to a site through the scraper: the status, Content-Type and body of the site. */
export const scraperFetch = (env: Env, url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => scraperCall(env, "fetch", { url, ...init });

/** The error of a scraper answer: the status of the site when it answered, else of the scraper. */
async function failure(res: Response) {
  const e = await res.json<{ error?: { code: string; status: number } }>().catch(() => null);
  return new ScraperError(e?.error?.status || res.status, e?.error?.code);
}

const HOSTS = /^(telegra\.ph|graph\.org|(www\.)?e621\.net|nhentai\.net|e-hentai\.org|hitomi\.la|imhentai\.xxx|hentaifox\.com|asmhentai\.com|(.+\.)?8muses\.com|multporn\.net|(.+\.)?allporncomic\.com|(.+\.)?kemono\.(cr|su|party)|(.+\.)?xlecx\.[a-z]+|(.+\.)?tailspace\.com|(.+\.)?yiffer\.xyz|(www\.)?(rule34\.xxx|gelbooru\.com|furaffinity\.net|pixiv\.net)|(.+\.)?donmai\.us)$/;

/** All gallery sites; the scraper checks the path (unsupported: the listing fails). */
export const scraper: GallerySource = {
  name: "scraper",
  match: (url) => HOSTS.test(url.hostname),
  async fetch(env, url, cursor, userId) {
    const auth = url.hostname.endsWith("e621.net") ? await e621Auth(env, userId) : undefined;
    const res = await scraperCall(env, "", { url: url.href, cursor, auth, limits: LIMITS });
    if (!res.ok) throw await failure(res);
    return res.json<Listing>();
  },
  async download(env, item: Item, site, headers) {
    if ("url" in item) {
      // Cloudflare's network first: some CDNs do not answer the scraper host; the scraper is for blocks and pages
      const direct = await fetch(item.url, { headers }).catch(() => null);
      if (direct?.ok) return direct;
    }
    const res = await scraperCall(env, "media", { site, ...("url" in item ? { url: item.url } : { page: item.page }) });
    return res.ok || !res.headers.get("Content-Type")?.includes("json") ? res : new Response(null, { status: (await failure(res)).status });
  },
};
