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

/** Saves one AI request cost and adds it to the user's total. */
export async function recordSpend(db: D1Database, s: Spend, model: string, keySource: "global" | "user", usage: Usage) {
  const cost = usage.cost ?? 0;
  await db.batch([
    db
      .prepare(
        "INSERT INTO transactions (user_id, kind, model, key_source, cost, prompt_tokens, completion_tokens, meme_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(s.userId, s.kind, model, keySource, cost, usage.prompt_tokens ?? null, usage.completion_tokens ?? null, s.memeId ?? null),
    db.prepare("UPDATE users SET total_cost = total_cost + ? WHERE id = ?").bind(cost, s.userId),
  ]);
}
