import type { Env } from "./env";
import { sign, verify } from "./media";

export const SESSION_TTL = 30 * 86400;
const now = () => Math.floor(Date.now() / 1000);

/** Stateless web session: "<userId>.<exp>.<hmac>". */
export async function createSession(env: Env, userId: number) {
  const exp = now() + SESSION_TTL;
  return `${userId}.${exp}.${await sign(env, `session|${userId}|${exp}`)}`;
}

export async function readSession(env: Env, token: string | null): Promise<number | null> {
  const [uid, exp, sig] = (token ?? "").split(".");
  if (!uid || !sig || Number(exp) < now()) return null;
  return (await verify(env, `session|${uid}|${exp}`, sig)) ? Number(uid) : null;
}

export const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export const getCookie = (req: Request, name: string) =>
  req.headers
    .get("Cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;
