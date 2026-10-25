import { env } from "cloudflare:test";
import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { syncCommands } from "../src/botcommands";

describe("syncCommands", () => {
  it("sets menus once and skips when nothing changed", async () => {
    await env.DB.prepare("INSERT INTO users (id, role, lang) VALUES (5, 'admin', 'ru')").run();
    const api = {
      setMyCommands: vi.fn(async () => true),
      deleteMyCommands: vi.fn(async () => true),
      setChatMenuButton: vi.fn(async () => true),
      setMyDescription: vi.fn(async () => true),
      setMyShortDescription: vi.fn(async () => true),
    };
    expect(await syncCommands(env, api as unknown as Api)).toBe(true);
    expect(api.setMyCommands).toHaveBeenCalledTimes(3);
    expect(api.setMyDescription).toHaveBeenCalledWith(expect.stringContaining("Нажмите «Начать»"), { language_code: "ru" });
    expect(api.setChatMenuButton).toHaveBeenCalledWith({
      menu_button: { type: "web_app", text: "Open App", web_app: { url: expect.stringMatching(/^https:\/\/[^/]+\/$/) } },
    });
    expect(api.setMyCommands).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ command: "grant", description: "Дать доступ" }]),
      { scope: { type: "chat", chat_id: 5 } },
    );
    expect(await syncCommands(env, api as unknown as Api)).toBe(false);
    expect(api.setMyCommands).toHaveBeenCalledTimes(3);
  });
});
