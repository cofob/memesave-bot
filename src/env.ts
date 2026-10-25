import type { Job } from "./queue";
import type { ZipImporter } from "./zip";
import type { DataExporter } from "./export";

export interface Env {
  DB: D1Database;
  VECTORS: Vectorize;
  MEDIA: R2Bucket; // permanent copies of all media; "tmp/" expires after 7 days
  JOBS: Queue<Job>;
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
  BTCPAY_URL?: string; // BTCPay Server (BTC, Lightning, XMR); payments are off without it
  BTCPAY_STORE_ID?: string;
  BTCPAY_API_KEY?: string; // secret: Greenfield API key with invoice create/view rights
  BTCPAY_WEBHOOK_SECRET?: string; // secret: webhook to PUBLIC_URL/pay/btcpay
  SHKEEPER_URL?: string; // SHKeeper (USDT); payments are off without it
  SHKEEPER_CRYPTOS?: string; // e.g. "ETH-USDT,POLYGON-USDT"
  SHKEEPER_API_KEY?: string; // secret
}
