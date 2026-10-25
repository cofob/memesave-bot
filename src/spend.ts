import { spendNotices, splitCost } from "./billing";
import { getUser } from "./db";
import type { Env } from "./env";

export interface Spend {
  userId: number;
  kind: string;
  memeId?: string;
}

export interface Usage {
  cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Saves one AI request cost and adds it to the user's total. For paid users on the shared key the cost is
 * covered by the month's included spend first, then by the balance.
 */
export async function recordSpend(env: Env, s: Spend, model: string, keySource: "global" | "user", usage: Usage) {
  const db = env.DB;
  const cost = usage.cost ?? 0;
  const user = await getUser(db, s.userId);
  const billed =
    user?.role === "paid" && keySource === "global" && cost > 0 ? await splitCost(db, user, cost) : { fromAllowance: 0, fromBalance: 0 };
  await db.batch([
    db
      .prepare(
        `INSERT INTO transactions (user_id, kind, model, key_source, cost, prompt_tokens, completion_tokens, meme_id, from_allowance, from_balance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        s.userId,
        s.kind,
        model,
        keySource,
        cost,
        usage.prompt_tokens ?? null,
        usage.completion_tokens ?? null,
        s.memeId ?? null,
        billed.fromAllowance,
        billed.fromBalance,
      ),
    db.prepare("UPDATE users SET total_cost = total_cost + ?, balance = balance - ? WHERE id = ?").bind(cost, billed.fromBalance, s.userId),
  ]);
  if (user && (billed.fromAllowance || billed.fromBalance)) {
    await spendNotices(env, user, billed.fromAllowance, billed.fromBalance).catch(console.error);
  }
}
