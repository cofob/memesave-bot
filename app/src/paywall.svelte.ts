/** Set when the API answers 402: the app shows the billing banner. */
export const paywall = $state<{ reason: string | null }>({ reason: null });
