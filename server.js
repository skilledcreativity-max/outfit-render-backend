"use strict";

const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { renderDesign, sanitizeRenderRequest } = require("./renderer");

const MAX_BODY_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;
const REQUIRED_ENVIRONMENT = ["RENDER_API_KEY", "PUBLIC_BASE_URL"];

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
  const publicBaseUrl = new URL(requiredEnvironment("PUBLIC_BASE_URL"));
  if (publicBaseUrl.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use HTTPS.");
  return Object.freeze({
    port: parseIntegerEnvironment("PORT", 3000, 1, 65535),
    apiKey: requiredEnvironment("RENDER_API_KEY"),
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
    maxRequestsPerMinute: parseIntegerEnvironment("RENDER_MAX_REQUESTS_PER_MINUTE", 12, 1, 60),
    maxConcurrentJobs: parseIntegerEnvironment("RENDER_MAX_CONCURRENT_JOBS", 1, 1, 4),
    maxQueueDepth: parseIntegerEnvironment("RENDER_MAX_QUEUE_DEPTH", 4, 0, 20),
    downloadTtlSeconds: parseIntegerEnvironment("RENDER_DOWNLOAD_TTL_SECONDS", 300, 60, 900),
    maxRetainedDownloads: parseIntegerEnvironment("RENDER_MAX_RETAINED_DOWNLOADS", 10, 1, 25),
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

function createEphemeralDownloadStore(config) {
  const downloads = new Map();

  function deleteExpired(now = Date.now()) {
    for (const [token, entry] of downloads) {
      if (entry.expiresAt <= now) downloads.delete(token);
    }
  }

  function discardOldest() {
    const oldest = downloads.keys().next().value;
    if (oldest) downloads.delete(oldest);
  }

  function putPng(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_OUTPUT_BYTES) {
      throw new Error("Generated output exceeds the safe delivery limit.");
    }
    deleteExpired();
    while (downloads.size >= config.maxRetainedDownloads) discardOldest();
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + config.downloadTtlSeconds * 1000;
    downloads.set(token, { buffer, expiresAt });
    return {
      imageUrl: `${config.publicBaseUrl}/download/${token}`,
      expiresInSeconds: config.downloadTtlSeconds,
    };
  }

  function takePng(token) {
    deleteExpired();
    const entry = downloads.get(token);
    if (!entry) return null;
    downloads.delete(token);
    return entry.buffer;
  }

  function healthCheck() {
    deleteExpired();
    return { retainedDownloads: downloads.size };
  }

  return Object.freeze({ putPng, takePng, healthCheck });
}

function createApp(config, options = {}) {
    const app = express();
  const queue = options.queue || createQueue(config.maxConcurrentJobs, config.maxQueueDepth);
  const downloads = options.storage || options.downloads || createEphemeralDownloadStore(config);
  const renderer = options.renderer || renderDesign;
  const startedAt = Date.now();
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
    keyGenerator: (request) => {
      const playerId = String(request.get("x-player-id") || "").replace(/\D/g, "").slice(0, 20);
      return playerId || ipKeyGenerator(request.ip);
    },
    message: { success: false, message: "Too many requests. Please retry later." },
  }));
  app.use(express.json({ limit: MAX_BODY_BYTES, strict: true, type: "application/json" }));

  app.get("/health", (_request, response) => {
    const state = queue.snapshot();
    const outputState = downloads.healthCheck();
    const overloaded = state.queuedJobs >= config.maxQueueDepth;
    response.status(overloaded ? 503 : 200).json({
      success: !overloaded,
      status: overloaded ? "overloaded" : "ready",
      mode: "ephemeral-free-beta",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      ...state,
      ...outputState,
    });
  });

  app.get("/metrics", (request, response) => {
    const suppliedKey = request.get("x-api-key") || "";
    if (!secureEquals(suppliedKey, config.apiKey)) return response.status(401).json({ success: false, message: "Unauthorized." });
    return response.json({ success: true, renderSuccesses, renderFailures, rejectedRequests, ...queue.snapshot(), ...downloads.healthCheck() });
  });

  app.get("/download/:token", (request, response) => {
    const token = request.params.token;
    if (!/^[a-f0-9]{64}$/i.test(token)) return response.status(404).send("Not found.");
    const png = downloads.takePng(token);
    if (!png) return response.status(404).send("This download link has expired or was already used.");
    response.set({
      "Cache-Control": "no-store, private, max-age=0",
      "Content-Disposition": "attachment; filename=outfit-studio-template.png",
      "Content-Length": String(png.length),
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    });
    return response.status(200).send(png);
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
    } catch (_error) {
      rejectedRequests += 1;
      return response.status(400).json({ success: false, message: "Invalid render request." });
    }

    try {
      const result = await queue.enqueue(async () => downloads.putPng(await renderer(design)));
      renderSuccesses += 1;
      return response.status(201).json({ success: true, imageUrl: result.imageUrl, expiresInSeconds: result.expiresInSeconds });
    } catch (error) {
      if (error && error.code === "QUEUE_FULL") return response.status(503).json({ success: false, message: "Renderer is busy. Please try again shortly." });
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

module.exports = { createApp, createConfiguration, createEphemeralDownloadStore, secureEquals };
