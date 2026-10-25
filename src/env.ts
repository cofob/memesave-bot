import type { Job } from "./queue";
import type { ZipImporter } from "./zip";
import type { DataExporter } from "./export";

export interface Env {
  DB: D1Database;
  VECTORS: Vectorize;
  MEDIA: R2Bucket; // permanent copies of all media; "tmp/" expires after 7 days
  JOBS: Queue<Job>;
  OAUTH_KV: KVNamespace; // MCP OAuth grants and tokens
  ZIP: DurableObjectNamespace<ZipImporter>;
  EXPORT: DurableObjectNamespace<DataExporter>;
  ADMIN_ID: string;
  PUBLIC_URL: string; // base URL of this Worker, e.g. https://memereserve.cfb.wtf
  MEDIA_URL?: string; // base URL for media links when R2 API keys are not set
  R2_ACCOUNT_ID?: string; // presigned R2 links for batch images (S3 API)
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID?: string; // secret: R2 API token with read access to R2_BUCKET
  R2_SECRET_ACCESS_KEY?: string; // secret
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
  ENCRYPTION_KEY: string;
  TG_CLIENT_SECRET: string; // BotFather → Login Widget → Client Secret
  BTCPAY_URL?: string; // BTCPay Server (BTC, XMR, USDT); payments are off without it
  BTCPAY_STORE_ID?: string;
  BTCPAY_API_KEY?: string; // secret: Greenfield API key with invoice create/view/modify rights
  BTCPAY_WEBHOOK_SECRET?: string; // secret: webhook to PUBLIC_URL/pay/btcpay
  BTCPAY_USDT?: string; // USDt plugin networks, e.g. "Ethereum,Polygon,Plasma" (payment methods USDT-ETHEREUM, …)
  COBALT_URL?: string; // cobalt API for TikTok links the Worker cannot download itself; https://api.cobalt.tools/ by default
  COBALT_API_KEY?: string; // secret
}
