import { Buffer } from "node:buffer";
import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { attachAudio, audioError } from "./audio";
import { billingStatus, canUseAi } from "./billing";
import { botApi } from "./botapi";
import { MCP_BODY_MAX, MCP_SCOPES } from "./config";
import { deleteMemes, getMeme, getUser, recordUse, visible, type Meme, type User } from "./db";
import type { Env } from "./env";
import { filterSql, facets } from "./filters";
import { memeMedia } from "./media";
import { agentSearch } from "./search/agent";
import { sendMeme } from "./search/deliver";
import { keywordSearch, regexSearch, validRegex } from "./search/hybrid";
import { cachedFastSearch } from "./search/inline";
import { userStats } from "./stats";
import { toDescription } from "./ingest/describe";
import { editMeme, parseEdit } from "./ingest/edit";
import { brief, detail, downloadLinks, kindOf, LIMITS, listMemes, ownMemes, retryMeme, saveUpload, tagCounts } from "./webapp";

// MCP server for outside AI agents: the user's library over OAuth (src/oauth.ts).

export type McpProps = { userId: number };

const VIEW_MAX = 5 << 20;

const INSTRUCTIONS = `Meme library of one Telegram user (memesave bot).
Search modes: "fts" keyword search (instant, free); "fast" hybrid vector + keyword search with an LLM query rewrite (small AI cost); "advanced" an LLM agent that also looks at images (slow, higher AI cost); "regex" a case-insensitive JavaScript regular expression over the text fields (free).
Thumbnail and file URLs are signed, need no auth and stay valid for at least 24 hours.
Uploads are processed in the background: poll get_meme until status is "ready".`;

const ok = (v: object) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], structuredContent: v as Record<string, unknown> });
const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

const filters = z
  .object({
    kind: z.array(z.enum(["photo", "video", "animation"])).optional(),
    status: z.array(z.enum(["ready", "processing", "failed"])).optional(),
    orient: z.array(z.enum(["landscape", "portrait", "square"])).optional(),
    text: z.enum(["yes", "no"]).optional().describe("has text in the image (OCR)"),
    porn: z
      .array(z.enum(["yes", "no"]))
      .optional()
      .describe("sexual content: [\"yes\"] only porn, [\"no\"] none; any value overrides the user's hide porn setting"),
    lang: z.array(z.string()).optional().describe("language codes, see get_filter_counts"),
    added: z.number().positive().optional().describe("added in the last N days"),
    dur: z.array(z.enum(["short", "medium", "long"])).optional().describe("video length: under 10 s, 10-60 s, over 60 s"),
  })
  .describe("metadata filters: values in one list are OR-ed, the lists are AND-ed");
type Filters = z.infer<typeof filters>;

/** Filters as the query of the app list (src/filters.ts reads it). */
function toUrl(params: Record<string, unknown> = {}) {
  const url = new URL("https://mcp.invalid/");
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  return url;
}

/** The memes that match the filters, in the order of `memes`. */
async function applyFilters(env: Env, userId: number, memes: Meme[], f?: Filters) {
  const { where, params } = filterSql(toUrl(f));
  if (!where.length || !memes.length) return memes;
  const ids = memes.map((m) => m.id);
  const { results } = await env.DB.prepare(`SELECT id FROM memes WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")}) AND ${where.join(" AND ")}`)
    .bind(userId, ...ids, ...params)
    .all<{ id: string }>();
  const keep = new Set(results.map((r) => r.id));
  return memes.filter((m) => keep.has(m.id));
}

/** The uploaded file from a URL or base64 data; a string is an error. */
async function uploadFile(a: { url?: string; data?: string; mime_type?: string; filename?: string }): Promise<File | string> {
  if (!a.url === !a.data) return "give exactly one of url or data";
  let bytes: ArrayBuffer;
  let mime = a.mime_type;
  if (a.url) {
    if (new URL(a.url).protocol !== "https:") return "url must be https";
    const res = await fetch(a.url);
    if (!res.ok) return `download failed: HTTP ${res.status}`;
    if (Number(res.headers.get("Content-Length")) > LIMITS.video) return "file too large";
    bytes = await res.arrayBuffer();
    mime ??= res.headers.get("Content-Type")?.split(";")[0].trim();
  } else {
    bytes = new Uint8Array(Buffer.from(a.data!, "base64")).buffer;
  }
  if (!mime || !kindOf(mime)) return "mime_type must be an image or video type";
  return new File([bytes], a.filename ?? "upload", { type: mime });
}

/** An audio file from an https URL; a string is an error. */
async function audioFile(url: string): Promise<File | string> {
  if (new URL(url).protocol !== "https:") return "audio_url must be https";
  const res = await fetch(url);
  if (!res.ok) return `audio download failed: HTTP ${res.status}`;
  const file = new File([await res.arrayBuffer()], "audio", { type: res.headers.get("Content-Type")?.split(";")[0].trim() ?? "" });
  return audioError(file) ?? file;
}

function buildServer(env: Env, user: User, scopes: string[]) {
  const server = new McpServer({ name: "memesave", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const own = async (id: string) => {
    const m = await getMeme(env.DB, id);
    return m?.user_id === user.id ? m : null;
  };
  const gate = async () => {
    const g = await canUseAi(env.DB, user);
    return g.ok ? null : fail(`payment required (${g.reason}): open ${env.PUBLIC_URL} to subscribe or top up`);
  };

  server.registerTool(
    "search_memes",
    {
      description: "Search the library by meaning, text on the meme, tags or title.",
      inputSchema: z.object({
        query: z.string().min(2).max(300),
        mode: z.enum(["fts", "fast", "advanced", "regex"]).optional().describe("default: the user's search mode setting"),
        filters: filters.optional(),
        limit: z.number().int().min(1).max(60).default(20),
      }),
      annotations: readOnly,
    },
    async ({ query, mode = user.search_mode, filters: f, limit }) => {
      if (mode === "regex" && !validRegex(query)) return fail("bad regex");
      if (mode !== "fts" && mode !== "regex") {
        const denied = await gate();
        if (denied) return denied;
      }
      const memes =
        mode === "regex"
          ? await regexSearch(env, user.id, query, 60)
          : mode === "fts"
            ? await keywordSearch(env, user.id, query, 60)
            : mode === "advanced"
              ? await agentSearch(env, user.id, query)
              : await cachedFastSearch(env, user.id, query);
      const found = (await applyFilters(env, user.id, visible(user, memes, f?.porn), f)).slice(0, limit);
      return ok({ items: await Promise.all(found.map((m) => brief(env, m))) });
    },
  );

  server.registerTool(
    "list_memes",
    {
      description: "List the library page by page (60 per page), with optional tag and metadata filters.",
      inputSchema: z.object({
        sort: z.enum(["new", "old", "title"]).default("new"),
        tag: z.string().optional().describe("exact tag, see list_tags"),
        filters: filters.optional(),
        offset: z.number().int().min(0).default(0).describe("next_offset of the previous page"),
      }),
      annotations: readOnly,
    },
    async ({ filters: f, ...rest }) => ok(await listMemes(env, user, toUrl({ ...f, ...rest }))),
  );

  server.registerTool("list_tags", { description: "Tags of the library with their meme counts (top 300).", annotations: readOnly }, async () =>
    ok({ tags: await tagCounts(env, user) }),
  );

  server.registerTool(
    "get_filter_counts",
    { description: "Meme counts for each filter value and the languages in the library.", annotations: readOnly },
    async () => ok(await facets(env.DB, user.id)),
  );

  server.registerTool(
    "get_meme",
    {
      description: "All metadata of a meme: status, title, description, OCR and speech text, tags, context, signed file URL.",
      inputSchema: z.object({ id: z.string() }),
      annotations: readOnly,
    },
    async ({ id }) => {
      const m = await own(id);
      return m ? ok(await detail(env, m)) : fail("meme not found");
    },
  );

  server.registerTool(
    "view_meme",
    {
      description: "Look at a meme: its preview image (a frame for videos), or the full photo with full=true.",
      inputSchema: z.object({ id: z.string(), full: z.boolean().default(false) }),
      annotations: readOnly,
    },
    async ({ id, full }) => {
      const m = await own(id);
      if (!m) return fail("meme not found");
      const media = await memeMedia(env, m, full && m.kind === "photo" ? "file" : "preview").catch(() => null);
      if (!media || !media.mime.startsWith("image/")) return fail("no image for this meme; use get_meme for its file URL");
      if (media.bytes.byteLength > VIEW_MAX) return fail("image too large; use download_memes");
      return {
        content: [
          { type: "text" as const, text: `${m.title ?? m.id} (${m.kind})` },
          { type: "image" as const, data: Buffer.from(media.bytes).toString("base64"), mimeType: media.mime },
        ],
      };
    },
  );

  server.registerTool(
    "download_memes",
    {
      description: "Signed download links (valid at least 24 hours) for up to 100 memes.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(100) }),
      annotations: readOnly,
    },
    async ({ ids }) => ok({ files: await downloadLinks(env, user.id, ids) }),
  );

  server.registerTool(
    "send_meme",
    {
      description: "Send a meme to the user's own Telegram chat with the bot.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      const m = await own(id);
      if (!m) return fail("meme not found");
      await sendMeme(env, botApi(env.BOT_TOKEN), user.id, m);
      await recordUse(env.DB, user.id, m.id, "send");
      return ok({ sent: true });
    },
  );

  server.registerTool("get_account", { description: "Account, settings, plan, balance and included AI spend left.", annotations: readOnly }, async () =>
    ok({
      id: user.id,
      username: user.username,
      role: user.role,
      search_mode: user.search_mode,
      describe_tier: user.describe_tier,
      own_openrouter_key: user.openrouter_key !== null,
      billing: await billingStatus(env, user),
    }),
  );

  server.registerTool("get_stats", { description: "Meme counts by kind and status, storage used (bytes) and AI spend in USD.", annotations: readOnly }, async () =>
    ok(await userStats(env, user)),
  );

  if (!scopes.includes(MCP_SCOPES.write)) return server;

  server.registerTool(
    "upload_meme",
    {
      description: "Add a photo, video or GIF (photos up to 10 MB, videos up to 50 MB) from an https URL or base64 data.",
      inputSchema: z.object({
        url: z.string().url().optional(),
        data: z.string().optional().describe("base64 file content (needs mime_type)"),
        mime_type: z.string().optional().describe("e.g. image/jpeg, image/gif, video/mp4"),
        filename: z.string().optional(),
        audio_url: z.string().url().optional().describe("https URL of a sound for a photo (mp3, m4a, ogg; up to 20 MB)"),
        description: z
          .object({
            title: z.string(),
            ocr_text: z.string().optional(),
            speech_text: z.string().optional(),
            language: z.string().optional(),
            description: z.string().optional(),
            meme_context: z.string().optional(),
            cultural_meaning: z.string().optional(),
            tags: z.array(z.string()).optional(),
            search_phrases: z.array(z.string()).optional(),
            porn: z.boolean().optional().describe("sexual content in the picture or frames; default false"),
          })
          .optional()
          .describe(
            "Do NOT fill this: a separate model recognizes the text, speech and meaning of every upload automatically. Only for a ready description from another memesave library (export).",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (a) => {
      const denied = await gate();
      if (denied) return denied;
      const file = await uploadFile(a);
      if (typeof file === "string") return fail(file);
      if (a.audio_url && kindOf(file.type) !== "photo") return fail("audio is only for photos");
      const audio = a.audio_url ? await audioFile(a.audio_url) : null;
      if (typeof audio === "string") return fail(audio);
      const res = await saveUpload(env, user, file, { description: a.description && toDescription(a.description, ""), via: "mcp" });
      if ("error" in res) return fail(res.error);
      if (audio) await attachAudio(env, (await getMeme(env.DB, res.id))!, audio);
      return ok(res);
    },
  );

  server.registerTool(
    "delete_memes",
    {
      description: "Delete memes with their files. Cannot be undone.",
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(100) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids }) => {
      const memes = await ownMemes(env, user.id, ids);
      await deleteMemes(env, memes.map((m) => m.id));
      return ok({ deleted: memes.map((m) => m.id) });
    },
  );

  server.registerTool(
    "set_meme_audio",
    {
      description: "Set the sound of a saved photo; on an album (carousel) it is one sound for all its photos. Without audio_url, removes the sound.",
      inputSchema: z.object({ id: z.string(), audio_url: z.string().url().optional().describe("https URL of mp3, m4a or ogg, up to 20 MB") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, audio_url }) => {
      const m = await own(id);
      if (!m) return fail("meme not found");
      const audio = audio_url ? await audioFile(audio_url) : null;
      if (typeof audio === "string") return fail(audio);
      const error = await attachAudio(env, m, audio);
      return error ? fail(error) : ok({ ok: true });
    },
  );

  server.registerTool(
    "edit_meme",
    {
      description: "Change fields of a meme (the others stay); search uses the new text at once. A meme in processing (or failed) is processed again; the AI keeps the edited fields.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().min(1).max(120).optional(),
        ocr_text: z.string().optional(),
        speech_text: z.string().optional(),
        language: z.string().max(20).optional().describe("ISO 639-1 code or 'none'"),
        description: z.string().optional(),
        meme_context: z.string().optional(),
        cultural_meaning: z.string().optional(),
        tags: z.array(z.string()).optional(),
        search_phrases: z.array(z.string()).optional(),
        porn: z.boolean().optional(),
        caption: z.string().max(4096).optional(),
        source: z.string().max(500).optional(),
        saved_at: z.number().int().nullable().optional().describe("unix time when it was saved at the source"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, ...fields }) => {
      const m = await own(id);
      if (!m) return fail("meme not found");
      const patch = parseEdit(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
      if (typeof patch === "string") return fail(patch);
      const res = await editMeme(env, m, patch);
      return typeof res === "string" ? fail(res) : ok(await detail(env, res));
    },
  );

  server.registerTool(
    "retry_meme",
    {
      description: "Process a failed meme again.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const m = await own(id);
      if (!m) return fail("meme not found");
      const denied = await gate();
      if (denied) return denied;
      return (await retryMeme(env, m)) ? ok({ ok: true }) : fail("meme has not failed");
    },
  );
  return server;
}

/** /mcp with a valid access token (OAuthProvider apiHandler). */
export const mcpApi = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const { props, auth } = ctx as OAuthResourceContext<McpProps>;
    const user = await getUser(env.DB, props.userId);
    if (!user) return Response.json({ error: "no access" }, { status: 403 });
    const handler = createMcpHandler(() => buildServer(env, user, auth.scope), { maxRequestBodySize: MCP_BODY_MAX });
    return handler.fetch(req, { authInfo: { token: auth.token, clientId: auth.clientId ?? "", scopes: auth.scope } });
  },
};
