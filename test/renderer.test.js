"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { Jimp, intToRGBA } = require("jimp");
const { createApp } = require("../server");
const { renderDesign, sanitizeRenderRequest } = require("../renderer");

function validRequest(overrides = {}) {
  return {
    requestId: "a".repeat(32),
    clothingType: "Shirt",
    sleeveType: "Long",
    baseColorHex: "#123456",
    patternAssetId: "",
    graphicAssetId: "",
    drawingStrokes: [],
    ...overrides,
  };
}

test("the renderer keeps base pixels inside active UV panels and transparent outside", async () => {
  const design = sanitizeRenderRequest(validRequest());
  const png = await renderDesign(design);
  const image = await Jimp.read(png);
  assert.equal(intToRGBA(image.getPixelColor(0, 0)).a, 0);
  assert.equal(intToRGBA(image.getPixelColor(231, 74)).a, 255);
  assert.equal(intToRGBA(image.getPixelColor(230, 74)).a, 0);
});

test("the schema drops shapes and brush strokes outside the active template mask", () => {
  const design = sanitizeRenderRequest(validRequest({
    sleeveType: "Sleeveless",
    drawingStrokes: [
      { tool: "Rectangle", x: 0, y: 0, width: 32, height: 32, rotation: 0, colorHex: "#FFFFFF" },
      { tool: "Brush", size: 6, colorHex: "#FFFFFF", points: [{ x: 0, y: 0 }] },
    ],
  }));
  assert.equal(design.drawingStrokes.length, 0);
});

test("the schema preserves supported rotated and polygon shapes that fit a garment panel", async () => {
  const design = sanitizeRenderRequest(validRequest({
    drawingStrokes: [
      { tool: "Triangle", x: 260, y: 100, width: 32, height: 32, rotation: 0, colorHex: "#FF0000" },
      { tool: "Hexagon", x: 290, y: 120, width: 20, height: 20, rotation: 20, colorHex: "#00FF00" },
    ],
  }));
  assert.equal(design.drawingStrokes.length, 2);
  const image = await Jimp.read(await renderDesign(design));
  assert.equal(intToRGBA(image.getPixelColor(276, 120)).a, 255);
});

test("malformed renderer requests are rejected before image work", () => {
  assert.throws(() => sanitizeRenderRequest({ ...validRequest(), requestId: "short" }));
  assert.throws(() => sanitizeRenderRequest({ ...validRequest(), baseColorHex: "blue" }));
  assert.throws(() => sanitizeRenderRequest({ ...validRequest(), drawingStrokes: {} }));
});

let server;
let baseUrl;
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("HTTP rendering requires the server secret and sanitizes direct requests", async () => {
  let capturedDesign = null;
  const app = createApp({
    apiKey: "test-render-secret",
    maxRequestsPerMinute: 100,
    maxConcurrentJobs: 1,
    maxQueueDepth: 2,
    signedUrlTtlSeconds: 120,
  }, {
    renderer: async (design) => {
      capturedDesign = design;
      return Buffer.from("test-png");
    },
    storage: {
      putPng: async () => ({ outputId: "b".repeat(64), imageUrl: "https://your-private-render-bucket.example.com/renders/test.png?signature=ok" }),
    },
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${baseUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validRequest()),
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "test-render-secret" },
    body: JSON.stringify(validRequest({
      drawingStrokes: [{ tool: "Rectangle", x: 0, y: 0, width: 32, height: 32, rotation: 0, colorHex: "#FFFFFF" }],
    })),
  });
  assert.equal(authorized.status, 201);
  assert.equal((await authorized.json()).success, true);
  assert.ok(capturedDesign);
  assert.equal(capturedDesign.drawingStrokes.length, 0);
});


test("valid artwork never creates opaque pixels outside the active garment mask", async () => {
  const design = sanitizeRenderRequest(validRequest({
    drawingStrokes: [{ tool: "Rectangle", x: 250, y: 100, width: 40, height: 40, rotation: 0, colorHex: "#FF0000" }],
  }));
  const image = await Jimp.read(await renderDesign(design));
  for (let y = 0; y < image.bitmap.height; y += 1) {
    for (let x = 0; x < image.bitmap.width; x += 1) {
      const insidePanel = design.panels.some((panel) => x >= panel.x && x < panel.x + panel.width && y >= panel.y && y < panel.y + panel.height);
      if (!insidePanel) assert.equal(intToRGBA(image.getPixelColor(x, y)).a, 0, `opaque pixel outside the mask at ${x},${y}`);
    }
  }
});

test("the asset policy ignores IDs that are not explicitly approved", () => {
  const design = sanitizeRenderRequest(validRequest({
    patternAssetId: "111111",
    graphicAssetId: "222222",
  }), {
    approvedPatternAssetIds: new Set(["333333"]),
    approvedGraphicAssetIds: new Set(["444444"]),
  });
  assert.equal(design.patternAssetId, "");
  assert.equal(design.graphicAssetId, "");
});

test("the renderer rejects oversized request bodies before processing", async () => {
  const oversized = "x".repeat(300 * 1024);
  const response = await fetch(`${baseUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "test-render-secret" },
    body: JSON.stringify({ ...validRequest(), padding: oversized }),
  });
  assert.equal(response.status, 413);
});


test("unknown top-level request fields are rejected by the strict schema", async () => {
  const response = await fetch(`${baseUrl}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "test-render-secret" },
    body: JSON.stringify({ ...validRequest(), unexpected: true }),
  });
  assert.equal(response.status, 400);
});

test("operational metrics require the renderer secret", async () => {
  const noSecret = await fetch(`${baseUrl}/metrics`);
  assert.equal(noSecret.status, 401);
  const authenticated = await fetch(`${baseUrl}/metrics`, { headers: { "x-api-key": "test-render-secret" } });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json()).success, true);
});

test("a full renderer queue returns a bounded service-unavailable response", async () => {
  let releaseWork;
  let markStarted;
  const workStarted = new Promise((resolve) => { markStarted = resolve; });
  const app = createApp({
    apiKey: "queue-test-secret",
    maxRequestsPerMinute: 100,
    maxConcurrentJobs: 1,
    maxQueueDepth: 0,
    signedUrlTtlSeconds: 120,
  }, {
    renderer: async () => {
      markStarted();
      await new Promise((resolve) => { releaseWork = resolve; });
      return Buffer.from("test-png");
    },
    storage: { putPng: async () => ({ outputId: "c".repeat(64), imageUrl: "https://your-private-render-bucket.example.com/renders/test.png?signature=ok" }) },
  });
  const temporaryServer = app.listen(0);
  await new Promise((resolve) => temporaryServer.once("listening", resolve));
  const url = `http://127.0.0.1:${temporaryServer.address().port}/render`;
  const requestOptions = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "queue-test-secret" },
    body: JSON.stringify(validRequest({ requestId: "d".repeat(32) })),
  };
  const firstRequest = fetch(url, requestOptions);
  await workStarted;
  const rejectedRequest = await fetch(url, requestOptions);
  assert.equal(rejectedRequest.status, 503);
  releaseWork();
  assert.equal((await firstRequest).status, 201);
  await new Promise((resolve) => temporaryServer.close(resolve));
});
