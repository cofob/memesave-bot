// Minimal typing for the parts of Telegram.WebApp the app uses.
interface WebApp {
  initData: string;
  initDataUnsafe: { user?: { language_code?: string } };
  colorScheme: "light" | "dark";
  themeParams: Record<string, string | undefined>;
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

/** Design system color tokens taken from Telegram's theme params. */
const themeColors: Record<string, string> = {
  canvas: "bg_color",
  surface: "secondary_bg_color",
  "surface-muted": "secondary_bg_color",
  "surface-raised": "section_bg_color",
  text: "text_color",
  "text-strong": "text_color",
  "text-muted": "subtitle_text_color",
  "text-subtle": "hint_color",
  border: "section_separator_color",
  focus: "button_color",
  accent: "button_color",
  "accent-hover": "button_color",
  "accent-active": "button_color",
  "accent-contrast": "button_text_color",
  danger: "destructive_text_color",
};

/** Follows Telegram's theme and colors; in a browser the design system follows the OS. */
export function syncTheme() {
  if (!tg) return;
  const root = document.documentElement;
  const apply = () => {
    root.dataset.theme = tg!.colorScheme;
    for (const [token, param] of Object.entries(themeColors)) {
      const color = tg!.themeParams[param];
      if (color) root.style.setProperty(`--cf-color-${token}`, color);
      else root.style.removeProperty(`--cf-color-${token}`);
    }
    for (const [token, mix] of [["accent-soft", 15], ["accent-soft-hover", 25]])
      root.style.setProperty(`--cf-color-${token}`, `color-mix(in srgb, var(--cf-color-accent) ${mix}%, var(--cf-color-canvas))`);
  };
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
