import { Zip, ZipPassThrough } from "fflate";
import type { Meme } from "./db";
import type { Env } from "./env";
import { extOf, memeMedia } from "./media";

/**
 * A .zip of the files of an album or comic in order (001.jpg, 002.mp4, …), streamed: the files are stored as they are
 * (media is compressed already) and read one by one, so a big comic does not fill the memory.
 */
export function albumZip(env: Env, memes: Meme[], name: string, headers: Record<string, string> = {}): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const out = writable.getWriter();
  const zip = new Zip((err, chunk, final) => {
    if (err) return void out.abort(err);
    void out.write(chunk);
    if (final) void out.close();
  });
  (async () => {
    for (const [i, m] of memes.entries()) {
      const media = await memeMedia(env, m, "file").catch(() => null); // a file that cannot be read is left out
      if (!media) continue;
      const file = new ZipPassThrough(`${String(i + 1).padStart(3, "0")}.${extOf(media.mime)}`);
      zip.add(file);
      file.push(new Uint8Array(media.bytes), true);
      await out.ready; // the client reads it before the next file
    }
    zip.end();
  })().catch((e) => out.abort(e));
  return new Response(readable, {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`, ...headers },
  });
}
