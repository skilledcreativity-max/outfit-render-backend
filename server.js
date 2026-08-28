"use strict";

const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { renderDesign, sanitizeRenderRequest } = require("./renderer");

const MAX_BODY_BYTES = 256 * 1024;
const REQUIRED_ENVIRONMENT = ["RENDER_API_KEY", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "PUBLIC_BASE_URL"];

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseIntegerEnvironment(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function parseAssetAllowlist(value) {
  return new Set((value || "").split(",").map((item) => item.replace(/\D/g, "")).filter((item) => item.length > 0 && item.length <= 20));
}

function createConfiguration() {
  for (const name of REQUIRED_ENVIRONMENT) requiredEnvironment(name);
  const baseUrl = new URL(requiredEnvironment("PUBLIC_BASE_URL"));
  if (baseUrl.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use HTTPS.");
  return Object.freeze({
    port: parseIntegerEnvironment("PORT", 3000, 1, 65535),
    apiKey: requiredEnvironment("RENDER_API_KEY"),
    publicBaseUrl: baseUrl.toString().replace(/\/$/, ""),
    bucket: requiredEnvironment("S3_BUCKET"),
    region: requiredEnvironment("S3_REGION"),
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    maxRequestsPerMinute: parseIntegerEnvironment("RENDER_MAX_REQUESTS_PER_MINUTE", 30, 1, 600),
    maxConcurrentJobs: parseIntegerEnvironment("RENDER_MAX_CONCURRENT_JOBS", 2, 1, 16),
    maxQueueDepth: parseIntegerEnvironment("RENDER_MAX_QUEUE_DEPTH", 20, 0, 200),
    signedUrlTtlSeconds: parseIntegerEnvironment("RENDER_SIGNED_URL_TTL_SECONDS", 900, 60, 3600),
    assetPolicy: {
      approvedPatternAssetIds: parseAssetAllowlist(process.env.APPROVED_PATTERN_ASSET_IDS),
      approvedGraphicAssetIds: parseAssetAllowlist(process.env.APPROVED_GRAPHIC_ASSET_IDS),
    },
  });
}

function secureEquals(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function createQueue(maxConcurrentJobs, maxQueueDepth) {
  let activeJobs = 0;
  const waiting = [];

  function processNext() {
    if (activeJobs >= maxConcurrentJobs || waiting.length === 0) return;
    const next = waiting.shift();
    activeJobs += 1;
    Promise.resolve()
      .then(next.work)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeJobs -= 1;
        processNext();
      });
  }

  function enqueue(work) {
    if (activeJobs >= maxConcurrentJobs && waiting.length >= maxQueueDepth) {
      const error = new Error("Renderer capacity is temporarily exhausted.");
      error.code = "QUEUE_FULL";
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      waiting.push({ work, resolve, reject });
      processNext();
    });
  }

  return Object.freeze({ enqueue, snapshot: () => ({ activeJobs, queuedJobs: waiting.length }) });
}

function createStorage(config) {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: requiredEnvironment("S3_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("S3_SECRET_ACCESS_KEY"),
    },
  });

  async function healthCheck() {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  }

  async function putPng(buffer) {
    const outputId = crypto.randomBytes(32).toString("hex");
    const key = `renders/${outputId}.png`;
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
      CacheControl: "private, max-age=0, no-store",
      ServerSideEncryption: "AES256",
      Metadata: { generatedBy: "outfit-studio-renderer-v2" },
    }));
    const imageUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key, ResponseContentType: "image/png", ResponseContentDisposition: "attachment" }), { expiresIn: config.signedUrlTtlSeconds });
    return { outputId, imageUrl };
  }

  return Object.freeze({ healthCheck, putPng });
}

function createApp(config, options = {}) {
  const app = express();
  const queue = options.queue || createQueue(config.maxConcurrentJobs, config.maxQueueDepth);
  const storage = options.storage || createStorage(config);
  const renderer = options.renderer || renderDesign;
  let startedAt = Date.now();
  let renderSuccesses = 0;
  let renderFailures = 0;
  let rejectedRequests = 0;

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use("/render", rateLimit({
    windowMs: 60 * 1000,
    limit: config.maxRequestsPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (request) => ipKeyGenerator(request.ip),
    message: { success: false, message: "Too many requests. Please retry later." },
  }));
  app.use(express.json({ limit: MAX_BODY_BYTES, strict: true, type: "application/json" }));

  app.get("/health", async (_request, response) => {
    const state = queue.snapshot();
    let storageReady = true;
    try {
      if (typeof storage.healthCheck === "function") await storage.healthCheck();
    } catch (error) {
      storageReady = false;
      console.error("Storage health check failed", { message: error instanceof Error ? error.message : "unknown" });
    }
    const overloaded = state.queuedJobs >= config.maxQueueDepth;
    const ready = storageReady && !overloaded;
    response.status(ready ? 200 : 503).json({
      success: ready,
      status: ready ? "ready" : (storageReady ? "overloaded" : "storage-unavailable"),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      ...state,
    });
  });

  app.get("/metrics", (request, response) => {
    const suppliedKey = request.get("x-api-key") || "";
    if (!secureEquals(suppliedKey, config.apiKey)) return response.status(401).json({ success: false, message: "Unauthorized." });
    return response.json({
      success: true,
      renderSuccesses,
      renderFailures,
      rejectedRequests,
      ...queue.snapshot(),
    });
  });

  app.post("/render", async (request, response) => {
    const suppliedKey = request.get("x-api-key") || "";
    if (!secureEquals(suppliedKey, config.apiKey)) {
      rejectedRequests += 1;
      return response.status(401).json({ success: false, message: "Unauthorized." });
    }

    let design;
    try {
      design = sanitizeRenderRequest(request.body, config.assetPolicy);
    } catch (error) {
      rejectedRequests += 1;
      return response.status(400).json({ success: false, message: "Invalid render request." });
    }

    try {
      const result = await queue.enqueue(async () => {
        const png = await renderer(design);
        return storage.putPng(png);
      });
      renderSuccesses += 1;
      return response.status(201).json({ success: true, imageUrl: result.imageUrl, expiresInSeconds: config.signedUrlTtlSeconds });
    } catch (error) {
      if (error && error.code === "QUEUE_FULL") {
        return response.status(503).json({ success: false, message: "Renderer is busy. Please try again shortly." });
      }
      renderFailures += 1;
      console.error("Render failed", { requestId: design.requestId, message: error instanceof Error ? error.message : "unknown" });
      return response.status(502).json({ success: false, message: "Template generation is temporarily unavailable." });
    }
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
      rejectedRequests += 1;
      return response.status(400).json({ success: false, message: "Invalid JSON body." });
    }
    if (error.type === "entity.too.large") {
      rejectedRequests += 1;
      return response.status(413).json({ success: false, message: "Request body is too large." });
    }
    console.error("Unhandled request error", { message: error instanceof Error ? error.message : "unknown" });
    return response.status(500).json({ success: false, message: "Internal service error." });
  });

  app.use((_request, response) => response.status(404).json({ success: false, message: "Not found." }));
  return app;
}

if (require.main === module) {
  const configuration = createConfiguration();
  const app = createApp(configuration);
  const server = app.listen(configuration.port, () => console.log(`Outfit renderer listening on ${configuration.publicBaseUrl}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = { createApp, createConfiguration, secureEquals };
