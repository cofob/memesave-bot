import type { Env } from "./env";

// OpenAPI 3.1 description of the HTTP API (/app/api/*), served without auth at /openapi.json.

export const serveOpenapi = (env: Env) => Response.json(openapi(env), { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string, description?: string) => ({ type: [type, "null"], ...(description ? { description } : {}) });
const ok = (description: string, schema: object = ref("Ok")) => ({ description, content: { "application/json": { schema } } });
const body = (schema: object, type = "application/json") => ({ required: true, content: { [type]: { schema } } });
const err = (description: string) => ok(description, ref("Error"));
const idParam = { name: "id", in: "path", required: true, description: "Meme id.", schema: { type: "string" } };
const csv = (name: string, values: string[], description: string) => ({
  name,
  in: "query",
  description: `${description} Comma separated, the values are OR-ed: ${values.join(", ")}.`,
  schema: { type: "string" },
  example: values[0],
});

const COMMON = { "403": err("No access: no or bad token, or a read-only token on a write request.") };
const PAID = { "402": ok("Payment required: no active plan or AI credit (`reason`: subscribe | credit).", ref("PaymentRequired")) };
const NOT_FOUND = { "404": err("The meme does not exist or belongs to another user.") };

const FILTERS = [
  csv("kind", ["photo", "video", "animation"], "Meme kind."),
  csv("status", ["ready", "processing", "failed"], "Processing status."),
  csv("orient", ["landscape", "portrait", "square"], "Orientation (10% tolerance for square)."),
  { name: "text", in: "query", description: "Has text on the image (OCR).", schema: { type: "string", enum: ["yes", "no"] } },
  { name: "lang", in: "query", description: "Language codes of the meme text, comma separated (see /facets).", schema: { type: "string" }, example: "en,ru" },
  { name: "added", in: "query", description: "Added in the last N days.", schema: { type: "number", minimum: 0 } },
  csv("dur", ["short", "medium", "long"], "Video length: under 10 s, 10–60 s, over 60 s."),
];

const schemas = {
  Ok: { type: "object", properties: { ok: { type: "boolean", const: true } }, required: ["ok"] },
  Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
  PaymentRequired: {
    type: "object",
    properties: { error: { type: "string", const: "payment required" }, reason: { type: "string", enum: ["subscribe", "credit"] } },
  },
  Kind: { type: "string", enum: ["photo", "video", "animation"], description: "animation is a GIF (stored as a silent mp4 by Telegram)." },
  Status: {
    type: "string",
    enum: ["embedding", "describing", "ready", "failed"],
    description: "Pipeline stage: embedding and describing are in progress, ready is searchable, failed can be retried.",
  },
  MemeBrief: {
    type: "object",
    description: "A meme in lists and search results.",
    properties: {
      id: { type: "string" },
      kind: ref("Kind"),
      title: nullable("string", "AI title; null until described."),
      status: ref("Status"),
      tags: { type: "array", items: { type: "string" } },
      thumb: { type: "string", format: "uri", description: "Signed preview image URL, no auth needed, valid for at least 24 hours." },
      width: nullable("integer"),
      height: nullable("integer"),
      duration: nullable("integer", "Seconds; videos and GIFs."),
      language: nullable("string", "Language code of the meme text; 'none' without text."),
      has_text: { type: "boolean", description: "OCR found text on the image." },
      created_at: { type: "integer", description: "Unix time when the meme was saved." },
      album: { type: "integer", description: "Only in /memes without tag or filters: the meme is the first one of an album with this many memes." },
    },
    required: ["id", "kind", "status", "tags", "thumb", "has_text", "created_at"],
  },
  MemeDetail: {
    allOf: [
      ref("MemeBrief"),
      {
        type: "object",
        properties: {
          caption: nullable("string", "The user's Telegram caption."),
          source: nullable("string", "Where it came from: the imported link or the forward origin."),
          saved_at: nullable("integer", "Unix time when the user saved it at the source (e.g. the TikTok like), when the uploader sent it."),
          description: nullable("string", "AI description of the content."),
          ocr_text: nullable("string", "Text on the image."),
          speech_text: nullable("string", "Speech in the video."),
          meme_context: nullable("string"),
          cultural_meaning: nullable("string"),
          file: nullable("string", "Signed URL of the original file (null when Telegram cannot give it: videos over 20 MB without an R2 copy)."),
          album: { type: "array", items: ref("MemeBrief"), description: "All memes of its album in order; empty for a single meme." },
        },
      },
    ],
  },
  Page: {
    type: "object",
    properties: {
      items: { type: "array", items: ref("MemeBrief") },
      next_offset: { type: ["integer", "null"], description: "Pass as offset for the next page; null on the last page." },
    },
    required: ["items", "next_offset"],
  },
  Upload: {
    type: "object",
    properties: {
      id: { type: "string" },
      duplicate: { type: "boolean", description: "The same file (SHA-256) is already saved: id is the existing meme." },
      batched: { type: "boolean", description: "The photo joined an open batch import (/batch in the bot): it is described later in bulk." },
    },
    required: ["id", "duplicate"],
  },
  Me: {
    type: "object",
    properties: {
      id: { type: "integer", description: "Telegram user id." },
      username: nullable("string"),
      role: { type: "string", enum: ["admin", "user", "paid"] },
      search_mode: { type: "string", enum: ["advanced", "fast"] },
      key: { type: "boolean", description: "Own OpenRouter key connected." },
      models: { type: "object", additionalProperties: { type: "string" } },
      describe_tier: { type: "string", enum: ["max", "medium"] },
      billing: { type: "object", description: "Plan, balance and the AI allowance left (USD)." },
    },
  },
};

const memeOps = (summary: string, description: string, extra: object = {}) => ({
  summary,
  description,
  parameters: [idParam],
  responses: { "200": ok("Done."), ...COMMON, ...NOT_FOUND },
  ...extra,
});

/** operationId from the summary: "Get a meme" → getMeme (for client generators). */
const camel = (s: string) =>
  s
    .toLowerCase()
    .replace(/ an? /g, " ")
    .replace(/ (\w)/g, (_, c: string) => c.toUpperCase());
const withIds = (paths: Record<string, Record<string, { summary: string; [k: string]: unknown }>>) =>
  Object.fromEntries(Object.entries(paths).map(([p, ops]) => [p, Object.fromEntries(Object.entries(ops).map(([m, op]) => [m, { operationId: camel(op.summary), ...op }]))]));

export function openapi(env: Env) {
  const server = `${env.PUBLIC_URL.replace(/\/$/, "")}/app/api`;
  return {
    openapi: "3.1.0",
    info: {
      title: "Memesave API",
      version: "1.0.0",
      description: `The meme library of one Telegram user (the memesave bot).

**Auth.** Create a token in the app: Account → Settings → API tokens, and send \`Authorization: Bearer <token>\`.
A read-only token can call GET endpoints only. Tokens cannot change the account (tokens, keys, billing, deletion).

**Processing.** New memes (upload, import) are processed in the background: embedding → describing → ready.
Poll \`GET /status?ids=\` or \`GET /memes/{id}\` until \`status\` is \`ready\` or \`failed\`.
Uploads, imports, retries and AI search need an active plan or AI credit, else the API answers 402.

**Media URLs** (\`thumb\`, \`file\`) are signed, need no auth and stay valid for at least 24 hours.

**Albums.** Memes that came together (a Telegram media group, a slideshow link) form an album.
Plain \`GET /memes\` lists an album as its first meme with \`album\` = its size; \`GET /memes/{id}\` returns the whole album.`,
    },
    servers: [{ url: server }],
    security: [{ token: [] }],
    components: {
      securitySchemes: { token: { type: "http", scheme: "bearer", description: "API token (msv_…) from Account → Settings → API tokens." } },
      schemas,
    },
    paths: withIds({
      "/me": { get: { summary: "Current account", description: "Account, settings and billing state.", responses: { "200": ok("The account.", ref("Me")), ...COMMON } } },
      "/stats": {
        get: {
          summary: "Library stats",
          description: "Meme counts by kind and status, and AI spend in USD (total, last 30 days, average per meme).",
          responses: { "200": ok("Stats.", { type: "object" }), ...COMMON },
        },
      },
      "/memes": {
        get: {
          summary: "List memes",
          description: "The library page by page (60 per page), with an optional exact tag and metadata filters. Without tag and filters an album is listed as its first meme.",
          parameters: [
            { name: "sort", in: "query", schema: { type: "string", enum: ["new", "old", "title"], default: "new" }, description: "new: newest first; old: oldest first; title: A–Z." },
            { name: "tag", in: "query", schema: { type: "string" }, description: "Exact tag (see /tags)." },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 }, description: "next_offset of the previous page." },
            ...FILTERS,
          ],
          responses: { "200": ok("A page of memes.", ref("Page")), ...COMMON },
        },
      },
      "/memes/{id}": {
        get: memeOps("Get a meme", "All metadata of a meme with signed file URLs and its album.", {
          responses: { "200": ok("The meme.", ref("MemeDetail")), ...COMMON, ...NOT_FOUND },
        }),
        delete: memeOps("Delete a meme", "Deletes the meme with its files and search index. Cannot be undone. Needs a write token."),
      },
      "/memes/{id}/retry": {
        post: memeOps("Retry a failed meme", "Runs the processing again for a meme with status failed. Needs a write token.", {
          responses: { "200": ok("Queued."), "409": err("The meme has not failed."), ...PAID, ...COMMON, ...NOT_FOUND },
        }),
      },
      "/memes/{id}/send": { post: memeOps("Send a meme", "Sends the meme to the user's chat with the bot. Needs a write token.") },
      "/memes/{id}/send_album": {
        post: memeOps("Send an album", "Sends the whole album of the meme (or the meme alone) to the user's chat with the bot, in albums of 10. Needs a write token."),
      },
      "/status": {
        get: {
          summary: "Processing status",
          description: "Status and title of up to 50 memes: poll this after an upload.",
          parameters: [{ name: "ids", in: "query", required: true, schema: { type: "string" }, description: "Meme ids, comma separated (max 50)." }],
          responses: {
            "200": ok("Statuses (unknown ids are left out).", {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" }, status: ref("Status"), title: nullable("string") } },
            }),
            ...COMMON,
          },
        },
      },
      "/search": {
        get: {
          summary: "Search memes",
          description: "Search by meaning, text on the meme, tags or title. fts: keyword search (instant, free); fast: hybrid vector + keyword search with an LLM query rewrite (small AI cost); advanced: an LLM agent that also looks at images (slow, higher cost). Filters are not applied: filter the results by their fields.",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 300 } },
            { name: "mode", in: "query", schema: { type: "string", enum: ["fts", "fast", "advanced"], default: "fast" } },
          ],
          responses: { "200": ok("Results, best first (up to 60; next_offset is always null).", ref("Page")), ...PAID, ...COMMON },
        },
      },
      "/tags": {
        get: {
          summary: "Tags",
          description: "Tags of the library with their meme counts, most used first (top 300).",
          responses: {
            "200": ok("Tags.", { type: "array", items: { type: "object", properties: { tag: { type: "string" }, count: { type: "integer" } } } }),
            ...COMMON,
          },
        },
      },
      "/facets": {
        get: {
          summary: "Filter counts",
          description: "Meme counts for every filter value (keys like `kind:photo`, `status:failed`) and the top 20 languages.",
          responses: {
            "200": ok("Counts.", {
              type: "object",
              properties: {
                counts: { type: "object", additionalProperties: { type: "integer" } },
                languages: { type: "array", items: { type: "object", properties: { value: { type: "string" }, count: { type: "integer" } } } },
              },
            }),
            ...COMMON,
          },
        },
      },
      "/index": {
        get: {
          summary: "Full text index",
          description: "All memes that have not failed, newest first, with OCR text (first 500 chars), search phrases and caption: for client-side search or a full sync.",
          responses: {
            "200": ok("All memes.", {
              type: "array",
              items: { allOf: [ref("MemeBrief"), { type: "object", properties: { ocr_text: { type: "string" }, phrases: { type: "string" }, caption: { type: "string" } } }] },
            }),
            ...COMMON,
          },
        },
      },
      "/files": {
        get: {
          summary: "Download links",
          description: "Signed download links (saved as attachments, valid at least 24 hours) for up to 100 memes. Memes without a downloadable file are left out.",
          parameters: [{ name: "ids", in: "query", required: true, schema: { type: "string" }, description: "Meme ids, comma separated (max 100)." }],
          responses: {
            "200": ok("Links.", {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, url: { type: "string", format: "uri" } } },
            }),
            ...COMMON,
          },
        },
      },
      "/upload": {
        post: {
          summary: "Upload a file",
          description:
            "Adds a photo (up to 10 MB), video or GIF (up to 50 MB). The same file twice returns the existing meme. Upload the files of a carousel one by one with the same `album` and their `position`. Needs a write token.",
          requestBody: body(
            {
              type: "object",
              properties: {
                file: { type: "string", format: "binary", description: "The file; its Content-Type decides the kind (image/gif is a GIF)." },
                thumb: { type: "string", format: "binary", description: "Optional JPEG preview for a video or GIF (under 1 MB); without it the AI sees no frame of large videos." },
                width: { type: "integer" },
                height: { type: "integer" },
                duration: { type: "integer", description: "Seconds." },
                source: { type: "string", maxLength: 500, description: "Where the file comes from, e.g. the post URL; shown as the meme source." },
                saved_at: { type: "integer", description: "Unix time when the user saved it at the source, e.g. the TikTok like." },
                caption: { type: "string", maxLength: 4096, description: "Text that came with the file, e.g. the TikTok post caption; the AI uses it as context." },
                album: {
                  type: "string",
                  maxLength: 100,
                  description: "Client album id: files uploaded with the same id form one album (a carousel), ordered by position.",
                  example: "tiktok:7300000000000000000",
                },
                position: { type: "integer", description: "Place of the file in its album, from 0." },
                description: {
                  type: "string",
                  description:
                    "Optional ready description as JSON: `title` (required), `ocr_text`, `speech_text`, `language`, `description`, `meme_context`, `cultural_meaning`, `tags` and `search_phrases` (string arrays). With it the AI description step is skipped and only embeddings are computed. Leave it out to let the AI describe the meme.",
                  example: '{"title":"Cat begs not to be turned into coffee","speech_text":"Noooo don\'t turn me into a coffee!","tags":["cat","latte art"]}',
                },
              },
              required: ["file"],
            },
            "multipart/form-data",
          ),
          responses: {
            "200": ok("Saved; processing runs in the background.", ref("Upload")),
            "409": err("Already saved."),
            "400": err("Bad description JSON."),
            "413": err("File too large."),
            "415": err("Not a photo, video or GIF."),
            ...PAID,
            ...COMMON,
          },
        },
      },
      "/import": {
        post: {
          summary: "Import a link",
          description: `Saves the media of a link from any service that cobalt supports (TikTok, Instagram, X, YouTube, Reddit, …).
The import runs in the background: the media is downloaded (videos in 720p), sent silently to the user's chat with the bot and saved
with \`source\` = the link. Slideshows and multi-media posts become one album in their order.
A link that is already saved (same \`source\`, not failed) is skipped. Failures are not reported back: check later with \`/memes\` or \`/index\`. Needs a write token.`,
          requestBody: body({ type: "object", properties: { url: { type: "string", format: "uri", example: "https://www.tiktok.com/@user/video/7300000000000000000" } }, required: ["url"] }),
          responses: { "202": ok("Queued.", { type: "object", properties: { queued: { type: "boolean", const: true } } }), "400": err("url required."), ...PAID, ...COMMON },
        },
      },
      "/delete": {
        post: {
          summary: "Delete memes",
          description: "Deletes up to 100 memes with their files. Ids of other users are ignored. Cannot be undone. Needs a write token.",
          requestBody: body({ type: "object", properties: { ids: { type: "array", items: { type: "string" }, maxItems: 100 } }, required: ["ids"] }),
          responses: { "200": ok("Deleted ids.", { type: "object", properties: { deleted: { type: "array", items: { type: "string" } } } }), ...COMMON },
        },
      },
    }),
  };
}
