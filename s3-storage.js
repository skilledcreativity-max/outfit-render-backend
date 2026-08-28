"use strict";

const crypto = require("crypto");

let S3Client, PutObjectCommand, GetObjectCommand, getSignedUrl;
try {
  ({ S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3"));
  ({ getSignedUrl } = require("@aws-sdk/s3-request-presigner"));
} catch (_error) {
  // These packages are optional: only required when S3 storage is actually configured
  // (i.e. when S3_BUCKET is set). Ephemeral in-memory storage doesn't need them.
}

function createS3DownloadStore(config) {
  if (!S3Client || !getSignedUrl) {
    throw new Error(
      "S3 storage is configured (S3_BUCKET is set) but @aws-sdk/client-s3 and " +
      "@aws-sdk/s3-request-presigner are not installed. Run `npm install` after " +
      "adding them to package.json."
    );
  }
  if (!config.s3Bucket) throw new Error("S3 storage requires S3_BUCKET to be configured.");

  const client = new S3Client({ region: config.s3Region });
  const keyPrefix = config.s3KeyPrefix.endsWith("/") ? config.s3KeyPrefix : `${config.s3KeyPrefix}/`;

  async function putPng(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("Generated output is empty or invalid.");
    }
    const key = `${keyPrefix}${crypto.randomBytes(24).toString("hex")}.png`;

    await client.send(new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
      CacheControl: "no-store, private, max-age=0",
    }));

    // The bucket must stay private (see s3-lifecycle.json / PRODUCTION_RUNBOOK.md
    // step 1). Access is only ever granted through this short-lived signed URL,
    // never a public bucket policy.
    const signedUrl = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: config.s3Bucket,
        Key: key,
        ResponseContentDisposition: "attachment; filename=outfit-studio-template.png",
      }),
      { expiresIn: config.downloadTtlSeconds },
    );

    return { imageUrl: signedUrl, expiresInSeconds: config.downloadTtlSeconds };
  }

  async function takePng() {
    // S3 objects are served directly via the signed URL above; this process
    // never proxies the bytes, so there is nothing to hand back here. Actual
    // deletion is handled by the bucket's lifecycle rule (s3-lifecycle.json),
    // independent of whether the signed link was ever used.
    return null;
  }

  async function healthCheck() {
    return { storageBackend: "s3", bucket: config.s3Bucket };
  }

  return Object.freeze({ putPng, takePng, healthCheck });
}

module.exports = { createS3DownloadStore };
