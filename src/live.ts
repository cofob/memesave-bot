import { DurableObject } from "cloudflare:workers";
import type { Meme } from "./db";
import type { Env } from "./env";
import { verifyQuery } from "./media";

/** Push events to the open web app / Mini App tabs of a user. */
export type LiveEvent =
  | { t: "meme"; id: string; status: Meme["status"]; title?: string | null }
  | { t: "job"; kind: "zip" | "export" | "batch" | "analysis" | "e621" };

/** One instance per user: the browser WebSockets of the user (hibernation API, so no cost while idle). */
export class Live extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); // keepalive without a wake-up
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(msg: string) {
    for (const ws of this.ctx.getWebSockets())
      try {
        ws.send(msg);
      } catch {
        // a closing socket
      }
  }

  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code);
  }
}

/** Sends the event to the user's open tabs; never throws. */
export const push = (env: Env, userId: number, e: LiveEvent) =>
  env.LIVE.get(env.LIVE.idFromName(String(userId))).send(JSON.stringify(e)).catch(() => {});

/** GET /app/live/<user id>?e=&s= — the WebSocket of a signed ticket (GET /app/api/live). */
export async function handleLive(req: Request, env: Env, url: URL) {
  const id = url.pathname.split("/")[3] ?? "";
  if (!/^\d+$/.test(id) || !(await verifyQuery(env, `live|${id}`, url))) return new Response("Forbidden", { status: 403 });
  if (req.headers.get("Upgrade") !== "websocket") return new Response("Upgrade Required", { status: 426 });
  return env.LIVE.get(env.LIVE.idFromName(id)).fetch(req);
}
