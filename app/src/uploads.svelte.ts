import { api, ApiError, type UploadMeta } from "./api";

export type UploadState = "queued" | "uploading" | "processing" | "batched" | "ready" | "duplicate" | "error";

export interface UploadItem {
  key: number;
  name: string;
  kind: "image" | "video" | "zip";
  progress: number;
  state: UploadState;
  detail?: string; // zip import progress, e.g. "40/115"
  error?: string;
  id?: string;
}

const LIMITS = { image: 10 << 20, video: 50 << 20 }; // Telegram send limits
const PARALLEL = 2;

export const uploads = $state({ items: [] as UploadItem[], open: false, collapsed: false });

const queue: { item: UploadItem; file: File }[] = [];
const readyListeners = new Set<(id: string) => void>();
let active = 0;
let nextKey = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

export const onUploadReady = (fn: (id: string) => void) => (readyListeners.add(fn), () => readyListeners.delete(fn));

const isZip = (file: File) => /\.zip$/i.test(file.name) || /zip/.test(file.type);

export function addFiles(files: Iterable<File>) {
  for (const file of files) {
    const kind = isZip(file) ? "zip" : file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;
    if (!kind) continue;
    uploads.items.push({ key: nextKey++, name: file.name, kind, progress: 0, state: "queued" });
    const item = uploads.items[uploads.items.length - 1]; // the reactive proxy
    if (kind !== "zip" && file.size > LIMITS[kind]) {
      item.state = "error";
      item.error = "file too large";
      continue;
    }
    queue.push({ item, file });
  }
  uploads.open = uploads.items.length > 0;
  uploads.collapsed = false;
  pump();
}

/** Removes finished rows and hides the panel when nothing is left. */
export function clearFinished() {
  uploads.items = uploads.items.filter((i) => i.state === "queued" || i.state === "uploading" || i.state === "processing");
  uploads.open = uploads.items.length > 0;
}

function pump() {
  while (active < PARALLEL && queue.length) {
    const job = queue.shift()!;
    active++;
    run(job.item, job.file).finally(() => {
      active--;
      pump();
    });
  }
}

async function run(item: UploadItem, file: File) {
  item.state = "uploading";
  if (item.kind === "zip") return runZip(item, file);
  try {
    const meta = item.kind === "video" ? await videoMeta(file) : await imageMeta(file);
    const res = await api.upload(file, meta, (p) => (item.progress = p));
    item.progress = 1;
    item.id = res.id;
    // Photos in an open batch wait for /batch_finish, so they are not polled.
    item.state = res.duplicate ? "duplicate" : res.batched ? "batched" : "processing";
    if (item.state === "processing") schedulePoll();
  } catch (e) {
    item.state = "error";
    item.error = e instanceof ApiError ? e.message : String(e);
  }
}

const ZIP_PART = 50 * 1024 * 1024; // under the 100 MB Worker request limit; R2 needs >= 5 MB parts

/** Zip import: same R2 multipart upload as the upload page, then the container progress. */
async function runZip(item: UploadItem, file: File) {
  try {
    const { id, url } = await api.zipCreate();
    item.id = id;
    const link = new URL(url);
    const at = (action: string, extra = "") => `${link.pathname}/${action}${link.search}${extra}`;
    const ok = async (res: Response) => {
      if (!res.ok) throw new ApiError(res.status, await res.text());
      return res.json();
    };
    await ok(await fetch(at("start"), { method: "POST" }));
    const parts = [];
    for (let i = 0; i * ZIP_PART < file.size; i++) {
      const blob = file.slice(i * ZIP_PART, (i + 1) * ZIP_PART);
      parts.push(await ok(await fetch(at("part", `&n=${i + 1}`), { method: "PUT", body: blob })));
      item.progress = Math.min(1, ((i + 1) * ZIP_PART) / file.size);
    }
    await ok(await fetch(at("complete"), { method: "POST", body: JSON.stringify({ parts }), headers: { "Content-Type": "application/json" } }));
    item.state = "processing";
    schedulePoll();
  } catch (e) {
    item.state = "error";
    item.error = e instanceof ApiError ? e.message : String(e);
  }
}

async function pollZip(item: UploadItem) {
  const z = await api.zipStatus(item.id!);
  if (z.total !== null) item.detail = `${z.imported}/${z.total}`;
  if (z.status === "done") {
    item.state = "ready";
    readyListeners.forEach((fn) => fn(item.id!));
  } else if (z.status === "failed") {
    item.state = "error";
    item.error = z.error ?? "import failed";
  }
}

/** Polls processing items until they are ready or failed. */
function schedulePoll() {
  pollTimer ??= setTimeout(async () => {
    pollTimer = undefined;
    const waiting = uploads.items.filter((i) => i.state === "processing" && i.id && i.kind !== "zip");
    await Promise.all(uploads.items.filter((i) => i.state === "processing" && i.kind === "zip").map((i) => pollZip(i).catch(() => {})));
    try {
      if (waiting.length) for (const row of await api.status(waiting.map((i) => i.id!))) {
        const item = waiting.find((i) => i.id === row.id);
        if (!item || (row.status !== "ready" && row.status !== "failed")) continue;
        item.state = row.status === "ready" ? "ready" : "error";
        if (row.title) item.name = row.title;
        if (item.state === "ready") readyListeners.forEach((fn) => fn(item.id!));
      }
    } catch {
      // try again on the next tick
    }
    if (uploads.items.some((i) => i.state === "processing")) schedulePoll();
  }, 3000);
}

async function imageMeta(file: File): Promise<UploadMeta> {
  try {
    const bitmap = await createImageBitmap(file);
    const meta = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return meta;
  } catch {
    return {};
  }
}

/** First frame as a JPEG thumbnail (max 640 px) plus size and duration; empty when the browser cannot decode it. */
async function videoMeta(file: File): Promise<UploadMeta> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  const once = (event: string) =>
    new Promise<void>((resolve, reject) => {
      video.addEventListener(event, () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("decode")), { once: true });
      setTimeout(() => reject(new Error("timeout")), 8000);
    });
  try {
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    await once("loadeddata");
    video.currentTime = Math.min(0.5, video.duration / 2 || 0);
    await once("seeked");
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    const thumb = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    return { thumb: thumb ?? undefined, width: video.videoWidth, height: video.videoHeight, duration: Math.round(video.duration) };
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}
