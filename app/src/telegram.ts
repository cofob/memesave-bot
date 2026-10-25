// Minimal typing for the parts of Telegram.WebApp the app uses.
interface WebApp {
  initData: string;
  initDataUnsafe: { user?: { language_code?: string } };
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast(version: string): boolean;
  onEvent(event: "themeChanged", cb: () => void): void;
  showConfirm(message: string, cb: (ok: boolean) => void): void;
  showAlert(message: string): void;
  shareMessage(id: string, cb?: (sent: boolean) => void): void;
  openLink(url: string): void;
  downloadFile(params: { url: string; file_name: string }, cb?: (accepted: boolean) => void): void;
  openInvoice(url: string, cb?: (status: "paid" | "cancelled" | "failed" | "pending") => void): void;
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

/** Opens a payment page: Telegram's browser in the Mini App, a new tab on the web. */
export const openTab = (url: string) => (tg ? tg.openLink(url) : window.open(url, "_blank", "noopener"));

/** Saves a file: Telegram's download prompt in the Mini App (Bot API 8.0+), a link with `download` on the web. */
export const saveFile = (url: string, name: string) =>
  new Promise<void>((resolve) => {
    if (tg?.isVersionAtLeast("8.0")) return tg.downloadFile({ url, file_name: name }, () => resolve());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    setTimeout(resolve, 300); // browsers drop downloads started too close together
  });

export const confirm = (message: string) =>
  new Promise<boolean>((resolve) => (tg ? tg.showConfirm(message, resolve) : resolve(window.confirm(message))));
