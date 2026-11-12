/** The pair partner whose memes the app shows; null: the user's own. */
export const viewing = $state<{ who: { id: number; name: string } | null }>({ who: null });
