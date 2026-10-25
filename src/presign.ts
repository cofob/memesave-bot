import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

/**
 * Presigned GET link to an object on the R2 S3 endpoint (*.r2.cloudflarestorage.com). Provider fetchers
 * that cannot reach Cloudflare-hosted Worker URLs (Vertex batch) can read it. Null without R2 API keys.
 */
export async function presignedR2Url(env: Env, key: string, ttlSeconds: number): Promise<string | null> {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_ACCOUNT_ID) return null;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const path = key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${path}`);
  url.searchParams.set("X-Amz-Expires", String(Math.min(ttlSeconds, 7 * 86400))); // R2 limit: 7 days
  const signed = await client.sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } });
  return signed.url;
}
