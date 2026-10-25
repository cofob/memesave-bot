import type { Job } from "./queue";
import type { ZipImporter } from "./zip";

export interface Env {
  DB: D1Database;
  VECTORS: Vectorize;
  MEDIA: R2Bucket; // permanent copies of all media; "tmp/" expires after 7 days
  JOBS: Queue<Job>;
  ZIP: DurableObjectNamespace<ZipImporter>;
  ADMIN_ID: string;
  PUBLIC_URL: string; // base URL of this Worker, e.g. https://memereserve.cfb.wtf
  MEDIA_URL?: string; // base URL for batch image URLs (workers.dev: outside the zone's bot rules)
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
  ENCRYPTION_KEY: string;
  TG_CLIENT_SECRET: string; // BotFather → Login Widget → Client Secret
}
