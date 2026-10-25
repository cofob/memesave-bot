import type { Api } from "grammy";
import { sha256hex } from "./cache";
import type { Role } from "./db";
import type { Env } from "./env";
import { t, type Key, type Lang } from "./i18n";

const USER_COMMANDS = ["start", "help", "stats", "settings", "key", "batch", "batch_zip", "batch_finish", "batch_cancel", "batch_status", "batch_retry", "export", "delete", "delete_all", "subscribe", "balance", "paysupport", "terms", "about"];
const ADMIN_COMMANDS = [...USER_COMMANDS, "grant", "revoke", "users"];

const list = (names: string[], lang: Lang) =>
  names.map((command) => ({ command, description: t(lang, `cmd_${command}` as Key) }));

/** Shows admin commands in an admin's chat menu, or resets the menu to the default one. */
export async function setCommandScope(api: Api, chatId: number, role: Role, lang: string | null) {
  const scope = { type: "chat", chat_id: chatId } as const;
  if (role === "admin") await api.setMyCommands(list(ADMIN_COMMANDS, lang === "ru" ? "ru" : "en"), { scope });
  else await api.deleteMyCommands({ scope });
}

/** Sets bot command menus when the command list or texts changed since the last sync. */
export async function syncCommands(env: Env, api: Api) {
  const appUrl = `${env.PUBLIC_URL.replace(/\/$/, "")}/`;
  const hash = await sha256hex(JSON.stringify([list(ADMIN_COMMANDS, "en"), list(ADMIN_COMMANDS, "ru"), appUrl]));
  const old = await env.DB.prepare("SELECT value FROM meta WHERE key = 'commands_hash'").first<string>("value");
  if (old === hash) return false;

  await api.setChatMenuButton({ menu_button: { type: "web_app", text: "Open App", web_app: { url: appUrl } } });
  await api.setMyCommands(list(USER_COMMANDS, "en"));
  await api.setMyCommands(list(USER_COMMANDS, "ru"), { language_code: "ru" });
  const { results } = await env.DB.prepare("SELECT id, lang FROM users WHERE role = 'admin'").all<{
    id: number;
    lang: string | null;
  }>();
  for (const a of results) await setCommandScope(api, a.id, "admin", a.lang).catch(console.error);

  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('commands_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(hash)
    .run();
  return true;
}
