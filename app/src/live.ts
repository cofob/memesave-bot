import { api } from "./api";

/** Server push (src/live.ts); "reconnect": events may be lost meanwhile, so reload what is shown. */
export type LiveEvent =
  | { t: "reconnect" }
  | { t: "meme"; id: string; status: string; title?: string | null }
  | { t: "job"; kind: "zip" | "export" | "batch" | "analysis" | "e621" };

const listeners = new Set<(e: LiveEvent) => void>();
let started = false;
let opened = false;
let delay = 1000;

/** Calls `fn` with each event of the own account; the first listener opens the WebSocket. */
export function onLive(fn: (e: LiveEvent) => void) {
  listeners.add(fn);
  if (!started) (started = true), connect();
  return () => void listeners.delete(fn);
}

const emit = (e: LiveEvent) => listeners.forEach((fn) => fn(e));
const retry = () => setTimeout(connect, (delay = Math.min(delay * 2, 30_000)));

async function connect() {
  // A ticket first: the Mini App authorizes by a header, which a WebSocket cannot send.
  const ws = await api.live().then(({ url }) => new WebSocket(new URL(url, location.href.replace(/^http/, "ws"))), () => null);
  if (!ws) return retry();
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000); // proxies drop idle sockets
  ws.onopen = () => {
    delay = 1000;
    if (opened) emit({ t: "reconnect" });
    opened = true;
  };
  ws.onmessage = (m) => m.data !== "pong" && emit(JSON.parse(m.data));
  ws.onclose = () => (clearInterval(ping), retry());
}
