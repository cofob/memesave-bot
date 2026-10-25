// Minimal typing for the parts of Telegram.WebApp the app uses.
interface WebApp {
  initData: string;
  initDataUnsafe: { user?: { language_code?: string } };
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  onEvent(event: "themeChanged", cb: () => void): void;
  showConfirm(message: string, cb: (ok: boolean) => void): void;
  showAlert(message: string): void;
  shareMessage(id: string, cb?: (sent: boolean) => void): void;
  openLink(url: string): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: { notificationOccurred(type: "success" | "error"): void };
}

const webApp = (window as unknown as { Telegram?: { WebApp: WebApp } }).Telegram?.WebApp;
/** The Mini App bridge, only when opened inside Telegram (the script also loads in a normal browser). */
export const tg: WebApp | undefined = webApp?.initData ? webApp : undefined;

/** Follows Telegram's light or dark theme; in a browser the design system follows the OS. */
export function syncTheme() {
  if (!tg) return;
  const apply = () => (document.documentElement.dataset.theme = tg!.colorScheme);
  apply();
  tg.onEvent("themeChanged", apply);
}

/** Opens an external page: the system browser in Telegram, the same tab on the web. */
export const openExternal = (url: string) => (tg ? tg.openLink(url) : (location.href = url));

export const confirm = (message: string) =>
  new Promise<boolean>((resolve) => (tg ? tg.showConfirm(message, resolve) : resolve(window.confirm(message))));
