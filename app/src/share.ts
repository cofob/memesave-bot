import { saveFile } from "./telegram";

const ext = (mime: string) => ({ "image/jpeg": "jpg", "video/quicktime": "mov" })[mime] ?? mime.split("/")[1]?.split(";")[0] ?? "bin";

// The files of the last share: after a slow download the browser may refuse the share sheet (no fresh tap), so a second tap shares them at once.
let ready: { key: string; urls: string[]; files: File[] } | null = null;

/**
 * Shares files with the system share sheet; where it cannot share files, downloads them.
 * Returns false when the files are ready but the sheet needs another tap.
 */
export async function shareFiles(key: string, name: string, urls: () => Promise<string[]>) {
  if (ready?.key !== key) {
    const list = await urls();
    const files = await Promise.all(
      list.map(async (u, i) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error(`file ${r.status}`);
        const b = await r.blob();
        return new File([b], `${name}${list.length > 1 ? `-${i + 1}` : ""}.${ext(b.type)}`, { type: b.type });
      }),
    );
    ready = { key, urls: list, files };
  }
  const { urls: list, files } = ready;
  if (!navigator.canShare?.({ files })) {
    for (const [i, u] of list.entries()) await saveFile(u, files[i].name);
    return true;
  }
  try {
    await navigator.share({ files });
  } catch (e) {
    if ((e as Error).name === "NotAllowedError") return false;
    if ((e as Error).name !== "AbortError") throw e; // AbortError: the user closed the sheet
  }
  return true;
}
