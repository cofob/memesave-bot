import type { Api, Composer } from "grammy";
import { grant, parseTarget, revoke, type Target } from "./auth";
import type { Ctx } from "./bot";
import { setCommandScope } from "./botcommands";
import type { Role, User } from "./db";
import type { Env } from "./env";
import { esc, t, usd } from "./i18n";

const show = (target: Target) => esc("id" in target ? String(target.id) : `@${target.username}`);

export type GrantResult = "granted" | "granted_pending" | "grant_usage";
export type RevokeResult = "revoked" | "user_not_found" | "revoke_denied" | "revoke_usage";

/** Gives a role by "@username" or id; updates the admin command menu. Shared by /grant and the app. */
export async function adminGrant(env: Env, api: Api, actor: User, arg: string, roleArg = "user"): Promise<{ result: GrantResult; target: string }> {
  const target = parseTarget(arg.trim());
  if (!target || !["user", "admin"].includes(roleArg)) return { result: "grant_usage", target: arg };
  const role = roleArg as Role;
  const id = await grant(env.DB, target, role, actor.id);
  if (id !== null) await setCommandScope(api, id, role, null).catch(console.error);
  return { result: id === null ? "granted_pending" : "granted", target: show(target) };
}

/** Removes access; the bootstrap admin and yourself cannot be removed. Shared by /revoke and the app. */
export async function adminRevoke(env: Env, api: Api, actor: User, arg: string): Promise<{ result: RevokeResult; target: string }> {
  const target = parseTarget(arg.trim());
  if (!target) return { result: "revoke_usage", target: arg };
  const self =
    ("id" in target && (String(target.id) === env.ADMIN_ID || target.id === actor.id)) ||
    ("username" in target && target.username === actor.username);
  if (self) return { result: "revoke_denied", target: show(target) };
  const { id, removed } = await revoke(env.DB, target);
  if (id !== null) await setCommandScope(api, id, "user", null).catch(console.error);
  return { result: removed ? "revoked" : "user_not_found", target: show(target) };
}

export interface UsersList {
  users: { id: number; username: string | null; role: Role; total_cost: number; memes: number }[];
  grants: { username: string; role: Role }[];
}

export async function listUsers(env: Env): Promise<UsersList> {
  const [users, grants] = await env.DB.batch<any>([
    env.DB.prepare(
      "SELECT u.id, u.username, u.role, u.total_cost, (SELECT COUNT(*) FROM memes m WHERE m.user_id = u.id) AS memes FROM users u ORDER BY u.created_at",
    ),
    env.DB.prepare("SELECT username, role FROM grants ORDER BY created_at"),
  ]);
  return { users: users.results, grants: grants.results };
}

export function registerAdmin<C extends Ctx>(bot: Composer<C>, env: Env) {
  const admin = bot.filter((ctx) => ctx.user.role === "admin");
  const html = { parse_mode: "HTML" } as const;

  admin.command("grant", async (ctx) => {
    const [arg = "", role] = ctx.match.split(/\s+/);
    const { result, target } = await adminGrant(env, ctx.api, ctx.user, arg, role);
    await ctx.reply(t(ctx.lang, result, { target, role: role ?? "user" }), html);
  });

  admin.command("revoke", async (ctx) => {
    const { result, target } = await adminRevoke(env, ctx.api, ctx.user, ctx.match);
    await ctx.reply(t(ctx.lang, result, { target }), html);
  });

  admin.command("users", async (ctx) => {
    const { users, grants } = await listUsers(env);
    const lines = users.map(
      (u) => `<code>${u.id}</code> ${u.username ? "@" + esc(u.username) : ""} — ${u.role}, ${u.memes} memes, ${usd(u.total_cost)}`,
    );
    let text = t(ctx.lang, "users", { lines: lines.join("\n") });
    if (grants.length) {
      text += t(ctx.lang, "users_pending", { lines: grants.map((g) => `@${esc(g.username)} — ${g.role}`).join("\n") });
    }
    await ctx.reply(text, html);
  });

  bot.command(["grant", "revoke", "users"], (ctx) => ctx.reply(t(ctx.lang, "admin_only"), html));
}
