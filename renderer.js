"use strict";

const { Jimp, JimpMime, cssColorToHex, intToRGBA, rgbaToInt } = require("jimp");

const TEMPLATE_WIDTH = 585;
const TEMPLATE_HEIGHT = 559;
const MAX_STROKES = 80;
const MAX_POINTS_PER_STROKE = 120;
const MAX_SHAPE_WIDTH = 160;
const MAX_SHAPE_HEIGHT = 160;
const MAX_BRUSH_SIZE = 36;
const MAX_ASSET_ID_LENGTH = 20;

const UV_PANELS = Object.freeze({
  Up: { name: "Up", x: 231, y: 8, width: 128, height: 64 },
  R: { name: "R", x: 165, y: 74, width: 64, height: 128 },
  Front: { name: "Front", x: 231, y: 74, width: 128, height: 128 },
  L: { name: "L", x: 361, y: 74, width: 64, height: 128 },
  Back: { name: "Back", x: 427, y: 74, width: 128, height: 128 },
  Down: { name: "Down", x: 231, y: 204, width: 128, height: 64 },
  RightArmU: { name: "RightArmU", x: 217, y: 289, width: 64, height: 64 },
  RightArmL: { name: "RightArmL", x: 19, y: 355, width: 64, height: 128 },
  RightArmB: { name: "RightArmB", x: 85, y: 355, width: 64, height: 128 },
  RightArmR: { name: "RightArmR", x: 151, y: 355, width: 64, height: 128 },
  RightArmF: { name: "RightArmF", x: 217, y: 355, width: 64, height: 128 },
  RightArmD: { name: "RightArmD", x: 217, y: 485, width: 64, height: 64 },
  LeftArmU: { name: "LeftArmU", x: 308, y: 289, width: 64, height: 64 },
  LeftArmF: { name: "LeftArmF", x: 308, y: 355, width: 64, height: 128 },
  LeftArmL: { name: "LeftArmL", x: 374, y: 355, width: 64, height: 128 },
  LeftArmB: { name: "LeftArmB", x: 440, y: 355, width: 64, height: 128 },
  LeftArmR: { name: "LeftArmR", x: 506, y: 355, width: 64, height: 128 },
  LeftArmD: { name: "LeftArmD", x: 308, y: 485, width: 64, height: 64 },
});

const SHAPE_TOOLS = new Set(["Rectangle", "Circle", "Rounded", "Triangle", "Star", "Pentagon", "Hexagon"]);
const PAINT_TOOLS = new Set(["Brush", "Eraser"]);
const REQUEST_FIELDS = new Set(["requestId", "clothingType", "sleeveType", "baseColorHex", "patternAssetId", "graphicAssetId", "graphicRect", "graphicRotation", "drawingStrokes"]);
const SHAPE_FIELDS = new Set(["tool", "x", "y", "width", "height", "rotation", "colorHex", "patternAssetId"]);
const PAINT_FIELDS = new Set(["tool", "points", "size", "colorHex"]);
const POINT_FIELDS = new Set(["x", "y"]);
const GRAPHIC_RECT_FIELDS = new Set(["x", "y", "width", "height"]);
const ASSET_CACHE = new Map();
// Approved pattern/graphic assets are curated and rarely change, so a longer
// TTL (paired with the periodic re-warm in server.js) keeps them cached
// across the server's whole lifetime instead of re-fetching from Roblox's
// thumbnail API on every export.
const ASSET_CACHE_TTL_MS = 60 * 60 * 1000;
const ASSET_CACHE_LIMIT = 100;

function isFiniteInteger(value) {
  return Number.isSafeInteger(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value, allowedKeys) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowedKeys.has(key));
}

function isHexColor(value) {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
}

function sanitizeAssetId(value, approvedAssetIds = new Set()) {
  if (typeof value !== "string") return "";
  const id = value.replace(/\D/g, "").slice(0, MAX_ASSET_ID_LENGTH);
  return id.length > 0 && approvedAssetIds.has(id) ? id : "";
}

function sanitizeClothingType(value) {
  return value === "Pants" ? "Pants" : "Shirt";
}

function sanitizeSleeveType(value, clothingType) {
  if (clothingType === "Pants") return value === "Shorts" ? "Shorts" : "Long";
  if (value === "Short" || value === "Sleeveless" || value === "Gloves") return value;
  return "Long";
}

function clonePanel(panel, height = panel.height) {
  return { name: panel.name, x: panel.x, y: panel.y, width: panel.width, height };
}

function getActivePanels(clothingType, sleeveType) {
  const torso = [UV_PANELS.Up, UV_PANELS.R, UV_PANELS.Front, UV_PANELS.L, UV_PANELS.Back, UV_PANELS.Down];
  const armNames = [
    "RightArmU", "RightArmL", "RightArmB", "RightArmR", "RightArmF", "RightArmD",
    "LeftArmU", "LeftArmF", "LeftArmL", "LeftArmB", "LeftArmR", "LeftArmD",
  ];

  if (clothingType === "Pants") {
    const pantsTorso = [
      UV_PANELS.Down,
      { ...UV_PANELS.R, name: "R", y: UV_PANELS.R.y + 64, height: 64 },
      { ...UV_PANELS.Front, name: "Front", y: UV_PANELS.Front.y + 64, height: 64 },
      { ...UV_PANELS.L, name: "L", y: UV_PANELS.L.y + 64, height: 64 },
      { ...UV_PANELS.Back, name: "Back", y: UV_PANELS.Back.y + 64, height: 64 },
    ];
    const legs = armNames.flatMap((name) => {
      const panel = UV_PANELS[name];
      if (sleeveType !== "Shorts") return [clonePanel(panel)];
      if (name.endsWith("D")) return [];
      return [clonePanel(panel, name.endsWith("U") ? panel.height : Math.floor(panel.height / 2))];
    });
    return [...pantsTorso, ...legs];
  }

  const shirt = torso.map((panel) => clonePanel(panel));
  if (sleeveType === "Sleeveless") return shirt;
  const arms = armNames.flatMap((name) => {
    const panel = UV_PANELS[name];
    if (sleeveType === "Gloves") return [clonePanel(panel)];
    if (name.endsWith("D")) return [];
    const height = name.endsWith("U") ? panel.height : sleeveType === "Short" ? Math.floor(panel.height / 2) : Math.floor(panel.height * 0.8);
    return [clonePanel(panel, height)];
  });
  return [...shirt, ...arms];
}

function pointInPanel(panel, x, y, padding = 0) {
  return x - padding >= panel.x && x + padding <= panel.x + panel.width
    && y - padding >= panel.y && y + padding <= panel.y + panel.height;
}

function findPanelForPoint(panels, x, y, padding = 0) {
  return panels.find((panel) => pointInPanel(panel, x, y, padding)) || null;
}

function rotatedBoundsFit(panel, shape) {
  const radians = shape.rotation * Math.PI / 180;
  const halfWidth = shape.width / 2;
  const halfHeight = shape.height / 2;
  const rotatedHalfWidth = Math.abs(halfWidth * Math.cos(radians)) + Math.abs(halfHeight * Math.sin(radians));
  const rotatedHalfHeight = Math.abs(halfWidth * Math.sin(radians)) + Math.abs(halfHeight * Math.cos(radians));
  const centerX = shape.x + halfWidth;
  const centerY = shape.y + halfHeight;
  return centerX - rotatedHalfWidth >= panel.x && centerX + rotatedHalfWidth <= panel.x + panel.width
    && centerY - rotatedHalfHeight >= panel.y && centerY + rotatedHalfHeight <= panel.y + panel.height;
}

function polygonContains(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const intersects = ((a.y > y) !== (b.y > y))
      && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function regularPolygon(sides, width, height) {
  const points = [];
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) / 2;
  for (let index = 0; index < sides; index += 1) {
    const angle = -Math.PI / 2 + index * (2 * Math.PI / sides);
    points.push({ x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) });
  }
  return points;
}

function shapeContains(tool, localX, localY, width, height) {
  if (tool === "Rectangle") return localX >= 0 && localX <= width && localY >= 0 && localY <= height;
  if (tool === "Circle") {
    const rx = width / 2;
    const ry = height / 2;
    if (rx <= 0 || ry <= 0) return false;
    return ((localX - rx) / rx) ** 2 + ((localY - ry) / ry) ** 2 <= 1;
  }
  if (tool === "Rounded") {
    const radius = Math.min(14, width / 2, height / 2);
    const nearestX = Math.max(radius, Math.min(width - radius, localX));
    const nearestY = Math.max(radius, Math.min(height - radius, localY));
    return (localX - nearestX) ** 2 + (localY - nearestY) ** 2 <= radius ** 2;
  }
  if (tool === "Triangle") return polygonContains([{ x: width / 2, y: 0 }, { x: width, y: height }, { x: 0, y: height }], localX, localY);
  if (tool === "Star") {
    const points = [];
    const centerX = width / 2;
    const centerY = height / 2;
    const outerRadius = Math.min(width, height) / 2;
    const innerRadius = outerRadius * 0.45;
    for (let index = 0; index < 10; index += 1) {
      const radius = index % 2 === 0 ? outerRadius : innerRadius;
      const angle = -Math.PI / 2 + index * Math.PI / 5;
      points.push({ x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) });
    }
    return polygonContains(points, localX, localY);
  }
  if (tool === "Pentagon") return polygonContains(regularPolygon(5, width, height), localX, localY);
  if (tool === "Hexagon") return polygonContains(regularPolygon(6, width, height), localX, localY);
  return false;
}

function multiplyRgba(baseColor, textureColor) {
  const base = intToRGBA(baseColor);
  const texture = intToRGBA(textureColor);
  return rgbaToInt(
    Math.round(base.r * texture.r / 255),
    Math.round(base.g * texture.g / 255),
    Math.round(base.b * texture.b / 255),
    Math.round(base.a * texture.a / 255),
  );
}

function drawShape(layer, shape, texture) {
  const fillColor = cssColorToHex(shape.colorHex);
  const radians = shape.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = shape.x + shape.width / 2;
  const centerY = shape.y + shape.height / 2;
  const halfBoundWidth = Math.abs(shape.width * cosine / 2) + Math.abs(shape.height * sine / 2);
  const halfBoundHeight = Math.abs(shape.width * sine / 2) + Math.abs(shape.height * cosine / 2);
  const startX = Math.max(0, Math.floor(centerX - halfBoundWidth));
  const endX = Math.min(TEMPLATE_WIDTH - 1, Math.ceil(centerX + halfBoundWidth));
  const startY = Math.max(0, Math.floor(centerY - halfBoundHeight));
  const endY = Math.min(TEMPLATE_HEIGHT - 1, Math.ceil(centerY + halfBoundHeight));

  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerY;
      const localX = dx * cosine + dy * sine + shape.width / 2;
      const localY = -dx * sine + dy * cosine + shape.height / 2;
      if (!shapeContains(shape.tool, localX, localY, shape.width, shape.height)) continue;
      const pixel = texture
        ? multiplyRgba(fillColor, texture.getPixelColor(x % texture.bitmap.width, y % texture.bitmap.height))
        : fillColor;
      layer.setPixelColor(pixel, x, y);
    }
  }
}

function clearPixel(image, x, y) {
  image.setPixelColor(0x00000000, x, y);
}

function drawCircle(layer, centerX, centerY, radius, colorHex, erase) {
  const color = erase ? 0x00000000 : cssColorToHex(colorHex);
  const startX = Math.max(0, Math.floor(centerX - radius));
  const endX = Math.min(TEMPLATE_WIDTH - 1, Math.ceil(centerX + radius));
  const startY = Math.max(0, Math.floor(centerY - radius));
  const endY = Math.min(TEMPLATE_HEIGHT - 1, Math.ceil(centerY + radius));
  const radiusSquared = radius * radius;
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 > radiusSquared) continue;
      if (erase) clearPixel(layer, x, y); else layer.setPixelColor(color, x, y);
    }
  }
}

function drawLine(layer, from, to, radius, colorHex, erase) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius / 2)));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    drawCircle(layer, Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t), radius, colorHex, erase);
  }
}

function sanitizeShape(raw, panels, approvedPatternAssetIds) {
  if (!hasOnlyKeys(raw, SHAPE_FIELDS)) return null;
  const tool = raw.tool;
  if (!SHAPE_TOOLS.has(tool)) return null;
  const fields = [raw.x, raw.y, raw.width, raw.height];
  if (!fields.every(isFiniteInteger) || !isFiniteInteger(raw.rotation || 0) || !isHexColor(raw.colorHex)) return null;
  if (raw.width < 1 || raw.height < 1 || raw.width > MAX_SHAPE_WIDTH || raw.height > MAX_SHAPE_HEIGHT) return null;
  if (raw.x < 0 || raw.y < 0 || raw.x + raw.width > TEMPLATE_WIDTH || raw.y + raw.height > TEMPLATE_HEIGHT) return null;
  const rotation = ((raw.rotation || 0) % 360 + 360) % 360;
  const shape = { tool, x: raw.x, y: raw.y, width: raw.width, height: raw.height, rotation, colorHex: raw.colorHex.toUpperCase(), patternAssetId: sanitizeAssetId(raw.patternAssetId, approvedPatternAssetIds) };
  return panels.some((panel) => rotatedBoundsFit(panel, shape)) ? shape : null;
}

function sanitizePaintStroke(raw, panels) {
  if (!hasOnlyKeys(raw, PAINT_FIELDS)) return null;
  const tool = raw.tool;
  if (!PAINT_TOOLS.has(tool) || !Array.isArray(raw.points) || raw.points.length < 1 || raw.points.length > MAX_POINTS_PER_STROKE) return null;
  if (!isFiniteInteger(raw.size) || raw.size < 1 || raw.size > MAX_BRUSH_SIZE || !isHexColor(raw.colorHex || "#000000")) return null;
  const radius = raw.size / 2;
  const points = [];
  let panelName = null;
  for (const point of raw.points) {
    if (!hasOnlyKeys(point, POINT_FIELDS) || !isFiniteInteger(point.x) || !isFiniteInteger(point.y)) return null;
    const panel = findPanelForPoint(panels, point.x, point.y, radius);
    if (!panel) return null;
    if (panelName && panel.name !== panelName) return null;
    panelName = panel.name;
    points.push({ x: point.x, y: point.y });
  }
  return { tool, points, size: raw.size, colorHex: (raw.colorHex || "#000000").toUpperCase() };
}

function sanitizeGraphicRect(rawRect, panels) {
  if (!hasOnlyKeys(rawRect, GRAPHIC_RECT_FIELDS) || ![rawRect.x, rawRect.y, rawRect.width, rawRect.height].every(isFiniteInteger)) return null;
  if (rawRect.width < 1 || rawRect.height < 1 || rawRect.width > 128 || rawRect.height > 128) return null;
  if (!isFiniteInteger(rawRect.rotation || 0)) return null;
  const front = panels.find((panel) => panel.name === "Front");
  if (!front) return null;
  const graphic = { x: rawRect.x, y: rawRect.y, width: rawRect.width, height: rawRect.height, rotation: ((rawRect.rotation || 0) % 360 + 360) % 360 };
  return rotatedBoundsFit(front, graphic) ? graphic : null;
}

function sanitizeRenderRequest(body, assetPolicy = {}) {
  if (!hasOnlyKeys(body, REQUEST_FIELDS)) throw new Error("Malformed render request.");
  const requestId = typeof body.requestId === "string" && /^[a-f0-9]{32}$/i.test(body.requestId) ? body.requestId.toLowerCase() : "";
  if (!requestId) throw new Error("Invalid request identifier.");
  const clothingType = sanitizeClothingType(body.clothingType);
  const sleeveType = sanitizeSleeveType(body.sleeveType, clothingType);
  if (!isHexColor(body.baseColorHex)) throw new Error("Invalid base color.");
  const panels = getActivePanels(clothingType, sleeveType);
  const approvedPatternAssetIds = assetPolicy.approvedPatternAssetIds || new Set();
  const approvedGraphicAssetIds = assetPolicy.approvedGraphicAssetIds || new Set();
  const drawingStrokes = [];
  if (body.drawingStrokes !== undefined && !Array.isArray(body.drawingStrokes)) throw new Error("Invalid artwork collection.");
  for (const rawStroke of (body.drawingStrokes || []).slice(0, MAX_STROKES)) {
    const shape = sanitizeShape(rawStroke, panels, approvedPatternAssetIds);
    const paint = shape ? null : sanitizePaintStroke(rawStroke, panels);
    if (shape) drawingStrokes.push(shape); else if (paint) drawingStrokes.push(paint);
  }
  const graphicAssetId = clothingType === "Shirt" ? sanitizeAssetId(body.graphicAssetId, approvedGraphicAssetIds) : "";
  const graphicRect = graphicAssetId ? sanitizeGraphicRect(body.graphicRect, panels) : null;
  if (graphicRect && !isFiniteInteger(body.graphicRotation || 0)) throw new Error("Invalid graphic rotation.");
  if (graphicRect) graphicRect.rotation = ((body.graphicRotation || 0) % 360 + 360) % 360;
  if (graphicRect && !rotatedBoundsFit(panels.find((panel) => panel.name === "Front"), graphicRect)) throw new Error("Graphic does not fit the front panel.");
  return {
    requestId,
    clothingType,
    sleeveType,
    baseColorHex: body.baseColorHex.toUpperCase(),
    patternAssetId: sanitizeAssetId(body.patternAssetId, approvedPatternAssetIds),
    graphicAssetId: graphicRect ? graphicAssetId : "",
    graphicRect,
    drawingStrokes,
    panels,
  };
}

function assertRobloxCdnUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(hostname === "rbxcdn.com" || hostname.endsWith(".rbxcdn.com"))) throw new Error("Unsupported image host.");
  return url;
}

async function fetchWithByteLimit(url, bytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error", headers: { Accept: "image/png,image/jpeg,image/webp" } });
  if (!response.ok) throw new Error("Asset request failed.");
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > bytes) throw new Error("Asset response exceeds the byte limit.");
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) throw new Error("Asset response is not an image.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > bytes) throw new Error("Asset response exceeds the byte limit.");
  return buffer;
}

async function fetchRobloxAssetImage(assetId) {
  if (!assetId) return null;
  const cached = ASSET_CACHE.get(assetId);
  if (cached && cached.expiresAt > Date.now()) return cached.image.clone();
  const promise = (async () => {
    const apiUrl = new URL("https://thumbnails.roblox.com/v1/assets");
    apiUrl.searchParams.set("assetIds", assetId);
    apiUrl.searchParams.set("size", "420x420");
    apiUrl.searchParams.set("format", "Png");
    const apiResponse = await fetch(apiUrl, { signal: AbortSignal.timeout(8000), redirect: "error", headers: { Accept: "application/json" } });
    if (!apiResponse.ok) throw new Error("Thumbnail lookup failed.");
    const payload = await apiResponse.json();
    const entry = payload && Array.isArray(payload.data) ? payload.data[0] : null;
    if (!entry || entry.state !== "Completed" || typeof entry.imageUrl !== "string") throw new Error("Thumbnail is unavailable.");
    const imageUrl = assertRobloxCdnUrl(entry.imageUrl);
    const image = await Jimp.read(await fetchWithByteLimit(imageUrl, 3 * 1024 * 1024));
    if (image.bitmap.width > 2048 || image.bitmap.height > 2048) throw new Error("Decoded image exceeds the dimension limit.");
    return image;
  })();
    const image = await promise;
  if (ASSET_CACHE.size >= ASSET_CACHE_LIMIT) ASSET_CACHE.delete(ASSET_CACHE.keys().next().value);
  ASSET_CACHE.set(assetId, { image, expiresAt: Date.now() + ASSET_CACHE_TTL_MS });
  return image.clone();
}

// Pre-fetches a list of asset IDs into ASSET_CACHE so the first export that
// uses one of them doesn't pay the Roblox thumbnail-API round trip. Called
// once at server startup and re-called periodically (see server.js) so the
// cache never goes fully cold while the process stays up. One failed asset
// never blocks the others.
async function warmAssetCache(assetIds) {
  const uniqueIds = Array.from(new Set(assetIds)).filter((id) => id);
  await Promise.all(uniqueIds.map(async (assetId) => {
    try {
      await fetchRobloxAssetImage(assetId);
    } catch (error) {
      console.warn(`[warm cache] Skipped asset ${assetId}:`, error.message);
    }
  }));
}

async function drawGraphic(layer, design) {
  if (!design.graphicAssetId || !design.graphicRect) return;
  const graphic = await fetchRobloxAssetImage(design.graphicAssetId);
  graphic.contain({ w: design.graphicRect.width, h: design.graphicRect.height });
  const graphicLayer = new Jimp({ width: design.graphicRect.width, height: design.graphicRect.height, color: 0x00000000 });
  graphicLayer.composite(graphic, Math.floor((design.graphicRect.width - graphic.bitmap.width) / 2), Math.floor((design.graphicRect.height - graphic.bitmap.height) / 2));
  if (design.graphicRect.rotation !== 0) graphicLayer.rotate({ deg: design.graphicRect.rotation, mode: false });
  layer.composite(graphicLayer, design.graphicRect.x, design.graphicRect.y);
}

async function renderDesign(design) {
  const baseLayer = new Jimp({ width: TEMPLATE_WIDTH, height: TEMPLATE_HEIGHT, color: 0x00000000 });
  const artworkLayer = new Jimp({ width: TEMPLATE_WIDTH, height: TEMPLATE_HEIGHT, color: 0x00000000 });
  const baseColor = cssColorToHex(design.baseColorHex);
  for (const panel of design.panels) {
    for (let y = panel.y; y < panel.y + panel.height; y += 1) {
      for (let x = panel.x; x < panel.x + panel.width; x += 1) baseLayer.setPixelColor(baseColor, x, y);
    }
  }

    if (design.patternAssetId) {
    console.warn(`[DEBUG] Fetching pattern asset ${design.patternAssetId} for request ${design.requestId}`);
    try {
      const pattern = await fetchRobloxAssetImage(design.patternAssetId);
      console.warn(`[DEBUG] Pattern asset ${design.patternAssetId} fetched OK, size=${pattern.bitmap.width}x${pattern.bitmap.height}`);
      pattern.resize({ w: 64, h: 64 });
      for (const panel of design.panels) {
        for (let y = panel.y; y < panel.y + panel.height; y += 1) {
          for (let x = panel.x; x < panel.x + panel.width; x += 1) {
            baseLayer.setPixelColor(multiplyRgba(baseLayer.getPixelColor(x, y), pattern.getPixelColor(x % 64, y % 64)), x, y);
          }
        }
      }
    } catch (error) {
      console.warn(`[DEBUG] Pattern asset ${design.patternAssetId} FAILED:`, error.stack || error.message);
    }
  } else {
    console.warn(`[DEBUG] No patternAssetId present for request ${design.requestId} — design.patternAssetId="${design.patternAssetId}"`);
  }

  await drawGraphic(artworkLayer, design);
  for (const stroke of design.drawingStrokes) {
    if (SHAPE_TOOLS.has(stroke.tool)) {
      let texture = null;
      if (stroke.patternAssetId) {
        try {
          texture = await fetchRobloxAssetImage(stroke.patternAssetId);
          texture.resize({ w: 48, h: 48 });
        } catch (error) {
          console.warn("Shape pattern skipped:", error.message);
        }
      }
      drawShape(artworkLayer, stroke, texture);
    } else if (PAINT_TOOLS.has(stroke.tool)) {
      const erase = stroke.tool === "Eraser";
      const radius = stroke.size / 2;
      if (stroke.points.length === 1) drawCircle(artworkLayer, stroke.points[0].x, stroke.points[0].y, radius, stroke.colorHex, erase);
      for (let index = 0; index < stroke.points.length - 1; index += 1) drawLine(artworkLayer, stroke.points[index], stroke.points[index + 1], radius, stroke.colorHex, erase);
    }
  }
  baseLayer.composite(artworkLayer, 0, 0);
  return baseLayer.getBuffer(JimpMime.png);
}

module.exports = {
  TEMPLATE_WIDTH,
  TEMPLATE_HEIGHT,
  UV_PANELS,
  getActivePanels,
  sanitizeRenderRequest,
  renderDesign,
  warmAssetCache,
};
