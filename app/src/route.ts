// The screen lives in the URL query on "/": paths belong to the server, the hash to Telegram (initData).
// Links open the same screen; back and forward move between screens.

let at: number = history.state?.at ?? 0; // index of the current history entry
const seen: string[] = []; // the query of our entries by index (this page load only)
seen[at] = location.search;

const href = (search: string) => `${location.pathname}${search}${location.hash}`;

/**
 * Shows `search` (with "?", or "") in the address bar. A return to the previous screen goes back in history
 * (so closing a screen does not leave it to reopen with "back"), a new screen gets an entry, the rest replaces.
 */
export function show(search: string, push: boolean) {
  if (search === location.search) return;
  if (push && at > 0 && seen[at - 1] === search) return history.back();
  if (push) at++;
  seen[at] = search;
  seen.length = at + 1;
  history[push ? "pushState" : "replaceState"]({ at }, "", href(search));
}

/** Calls `cb` with the new query on back and forward. */
export function onRoute(cb: (p: URLSearchParams) => void) {
  const pop = () => {
    at = history.state?.at ?? 0;
    seen[at] = location.search;
    cb(new URLSearchParams(location.search));
  };
  addEventListener("popstate", pop);
  return () => removeEventListener("popstate", pop);
}
