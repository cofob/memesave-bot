import type { Env } from "./env";
import { decrypt, encrypt } from "./userkey";

// Session cookies of the user's pixiv and Fur Affinity accounts: the scraper sends them in the site requests of the
// user's imports (R-18 and mature works need a login). Encrypted like the other user secrets; never logged.

export const SITES = { pixiv: ["PHPSESSID"], furaffinity: ["a", "b"] } as const; // the cookies of the session
export type Site = keyof typeof SITES;
const HOSTS: Record<string, Site> = { "pixiv.net": "pixiv", "furaffinity.net": "furaffinity" };

export const isSite = (s: string): s is Site => Object.hasOwn(SITES, s);

/** The site of a link host that takes the user's cookies, if any. */
export const cookieSite = (host: string): Site | undefined => HOSTS[host.replace(/^www\./, "")];

/** Saves the cookies (values by name); false when one is missing or not a cookie value. */
export async function linkCookies(env: Env, userId: number, site: Site, values: Record<string, unknown>) {
  const vals = SITES[site].map((n) => String(values[n] ?? "").trim());
  if (!vals.every((v) => /^[^\s;,]+$/.test(v))) return false;
  const cookie = SITES[site].map((n, i) => `${n}=${vals[i]}`).join("; ");
  await env.DB.prepare(
    `INSERT INTO site_cookies (user_id, site, cookie) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id, site) DO UPDATE SET cookie = ?3, error = NULL, created_at = unixepoch()`,
  )
    .bind(userId, site, await encrypt(env.ENCRYPTION_KEY, cookie))
    .run();
  return true;
}

export const unlinkCookies = (db: D1Database, userId: number, site: Site) => db.prepare("DELETE FROM site_cookies WHERE user_id = ? AND site = ?").bind(userId, site).run();

/** The linked sites: { pixiv?: { error, created_at }, furaffinity?: … }. */
export async function cookiesStatus(db: D1Database, userId: number) {
  const { results } = await db.prepare("SELECT site, error, created_at FROM site_cookies WHERE user_id = ?").bind(userId).all<{ site: Site; error: string | null; created_at: number }>();
  return Object.fromEntries(results.map(({ site, ...r }) => [site, r]));
}

/** The Cookie header of the user's session on the site, if linked. */
export async function siteCookie(env: Env, userId: number, site: Site) {
  const sealed = await env.DB.prepare("SELECT cookie FROM site_cookies WHERE user_id = ? AND site = ?").bind(userId, site).first<string>("cookie");
  return sealed ? decrypt(env.ENCRYPTION_KEY, sealed) : undefined;
}

/** The site showed the login wall with the cookies: the user links them again. */
export const cookiesExpired = (db: D1Database, userId: number, site: Site) => db.prepare("UPDATE site_cookies SET error = 'expired' WHERE user_id = ? AND site = ?").bind(userId, site).run();
