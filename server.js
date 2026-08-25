// Outfit Studio Render Backend
// Composites base colors, patterns, chest decals, and custom drawn brush/eraser strokes
// into an official 585x559 transparent classic Roblox clothing template PNG.

const express = require('express');
const Jimp = require('jimp');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
// Increased JSON limit to accommodate drawing stroke coordinate payloads
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const RENDER_DIR = path.join(__dirname, 'renders');
if (!fs.existsSync(RENDER_DIR)) {
	fs.mkdirSync(RENDER_DIR, { recursive: true });
}

// Serve rendered templates statically at /renders/<code>.png
app.use('/renders', express.static(RENDER_DIR));

const TEMPLATE_WIDTH = 585;
const TEMPLATE_HEIGHT = 559;

// Official Roblox CDN template URLs
const OFFICIAL_TEMPLATES = {
	Shirt: 'https://static.rbxcdn.com/images/Template-Shirts-R15_07262019.png',
	Pants: 'https://static.rbxcdn.com/images/Template-Pants-R15_07262019.png',
};

// Official Roblox Classic Clothing Template UV Coordinates (585 x 559)
const UV_PANELS = {
	// Torso (128x128 front/back, 64x128 sides, 128x64 top/bottom)
	TORSO_TOP:    { x: 231, y: 8,   w: 128, h: 64  },
	TORSO_RIGHT:  { x: 165, y: 74,  w: 64,  h: 128 },
	TORSO_FRONT:  { x: 231, y: 74,  w: 128, h: 128 },
	TORSO_LEFT:   { x: 361, y: 74,  w: 64,  h: 128 },
	TORSO_BACK:   { x: 427, y: 74,  w: 128, h: 128 },
	TORSO_BOTTOM: { x: 231, y: 204, w: 128, h: 64  },

	// Right Arm / Leg
	R_TOP:        { x: 217, y: 289, w: 64, h: 64  },
	R_RIGHT:      { x: 151, y: 355, w: 64, h: 128 },
	R_FRONT:      { x: 217, y: 355, w: 64, h: 128 },
	R_LEFT:       { x: 19,  y: 355, w: 64, h: 128 },
	R_BACK:       { x: 85,  y: 355, w: 64, h: 128 },
	R_BOTTOM:     { x: 217, y: 485, w: 64, h: 64  },

	// Left Arm / Leg
	L_TOP:        { x: 308, y: 289, w: 64, h: 64  },
	L_RIGHT:      { x: 506, y: 355, w: 64, h: 128 },
	L_FRONT:      { x: 308, y: 355, w: 64, h: 128 },
	L_LEFT:       { x: 374, y: 355, w: 64, h: 128 },
	L_BACK:       { x: 440, y: 355, w: 64, h: 128 },
	L_BOTTOM:     { x: 308, y: 485, w: 64, h: 64  },
};

function fillRectOnCanvas(canvas, rect, hexColor) {
	let color;
	try {
		// Jimp's constructor needs a 0xRRGGBBAA integer, not a "#RRGGBB" string —
		// passing the raw CSS string in (as this used to) silently produces a
		// bogus near-black fill instead of the picked color.
		color = Jimp.cssColorToHex(hexColor);
	} catch {
		color = 0xFFFFFFFF;
	}
	const block = new Jimp(rect.w, rect.h, color);
	canvas.composite(block, rect.x, rect.y);
}

// Rasterizes player brush and eraser circles onto the Jimp image
function drawCircle(image, cx, cy, radius, hexColor, isEraser = false) {
	let color = 0x00000000;
	if (!isEraser) {
		try {
			color = Jimp.cssColorToHex(hexColor);
		} catch {
			color = 0xFFFFFFFF;
		}
	}

	for (let y = -radius; y <= radius; y++) {
		for (let x = -radius; x <= radius; x++) {
			if (x * x + y * y <= radius * radius) {
				const px = cx + x;
				const py = cy + y;
				if (px >= 0 && px < TEMPLATE_WIDTH && py >= 0 && py < TEMPLATE_HEIGHT) {
					image.setPixelColor(color, px, py);
				}
			}
		}
	}
}

// Interpolates smooth lines between mouse/touch stroke points without gaps
function drawLine(image, x0, y0, x1, y1, radius, hexColor, isEraser = false) {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const distance = Math.hypot(dx, dy);
	const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius / 2)));

	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const x = Math.round(x0 + dx * t);
		const y = Math.round(y0 + dy * t);
		drawCircle(image, x, y, radius, hexColor, isEraser);
	}
}

// Rasterizes solid filled rectangles
function drawFilledRect(image, x, y, w, h, hexColor) {
	let color;
	try {
		color = Jimp.cssColorToHex(hexColor);
	} catch {
		color = 0xFFFFFFFF;
	}
	const startX = Math.max(0, Math.floor(x));
	const startY = Math.max(0, Math.floor(y));
	const endX = Math.min(TEMPLATE_WIDTH, Math.floor(x + w));
	const endY = Math.min(TEMPLATE_HEIGHT, Math.floor(y + h));

	for (let py = startY; py < endY; py++) {
		for (let px = startX; px < endX; px++) {
			image.setPixelColor(color, px, py);
		}
	}
}

// Rasterizes solid filled circles and ellipses
function drawFilledCircleOrEllipse(image, x, y, w, h, hexColor) {
	let color;
	try {
		color = Jimp.cssColorToHex(hexColor);
	} catch {
		color = 0xFFFFFFFF;
	}
	const rx = w / 2;
	const ry = h / 2;
	if (rx <= 0 || ry <= 0) return;
	const cx = x + rx;
	const cy = y + ry;

	const startX = Math.max(0, Math.floor(x));
	const startY = Math.max(0, Math.floor(y));
	const endX = Math.min(TEMPLATE_WIDTH, Math.ceil(x + w));
	const endY = Math.min(TEMPLATE_HEIGHT, Math.ceil(y + h));

	for (let py = startY; py < endY; py++) {
		for (let px = startX; px < endX; px++) {
			const dx = (px - cx + 0.5) / rx;
			const dy = (py - cy + 0.5) / ry;
			if (dx * dx + dy * dy <= 1) {
				image.setPixelColor(color, px, py);
			}
		}
	}
}

// Rasterizes rounded rectangles
function drawFilledRoundedRect(image, x, y, w, h, hexColor, radius = 14) {
	let color;
	try {
		color = Jimp.cssColorToHex(hexColor);
	} catch {
		color = 0xFFFFFFFF;
	}
	const r = Math.min(radius, Math.floor(w / 2), Math.floor(h / 2));
	const rSq = r * r;

	const startX = Math.max(0, Math.floor(x));
	const startY = Math.max(0, Math.floor(y));
	const endX = Math.min(TEMPLATE_WIDTH, Math.floor(x + w));
	const endY = Math.min(TEMPLATE_HEIGHT, Math.floor(y + h));

	for (let py = startY; py < endY; py++) {
		for (let px = startX; px < endX; px++) {
			let inside = true;
			if (px < x + r && py < y + r) {
				const dx = px - (x + r);
				const dy = py - (y + r);
				if (dx * dx + dy * dy > rSq) inside = false;
			} else if (px >= x + w - r && py < y + r) {
				const dx = px - (x + w - r);
				const dy = py - (y + r);
				if (dx * dx + dy * dy > rSq) inside = false;
			} else if (px < x + r && py >= y + h - r) {
				const dx = px - (x + r);
				const dy = py - (y + h - r);
				if (dx * dx + dy * dy > rSq) inside = false;
			} else if (px >= x + w - r && py >= y + h - r) {
				const dx = px - (x + w - r);
				const dy = py - (y + h - r);
				if (dx * dx + dy * dy > rSq) inside = false;
			}

			if (inside) {
				image.setPixelColor(color, px, py);
			}
		}
	}
}

// Fetches asset images from the Roblox Thumbnails API (with retry logic)
async function fetchRobloxAssetImage(assetId) {
	if (!assetId) return null;

	const thumbUrl = `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=420x420&format=Png`;
	const maxAttempts = 4;
	const delayMs = 1500;

	let entry = null;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const thumbResponse = await axios.get(thumbUrl, { timeout: 10000 });
		entry = thumbResponse.data && thumbResponse.data.data && thumbResponse.data.data[0];

		if (entry && entry.state === 'Completed' && entry.imageUrl) {
			break;
		}

		if (attempt < maxAttempts) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	if (!entry || entry.state !== 'Completed' || !entry.imageUrl) {
		throw new Error(`Thumbnail not available for asset ${assetId} after ${maxAttempts} attempts (state: ${entry && entry.state})`);
	}

	const imageResponse = await axios.get(entry.imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
	return Jimp.read(Buffer.from(imageResponse.data));
}

app.post('/render', async (req, res) => {
	try {
		const {
			exportCode,
			clothingType,
			sleeveType,
			baseColorHex,
			patternAssetId,
			graphicAssetId,
			drawingStrokes
		} = req.body;

		const isPants = clothingType === 'Pants';
		const sleeve = sleeveType || 'Long';

		if (!exportCode || !baseColorHex) {
			return res.status(400).json({ success: false, message: 'Missing exportCode or baseColorHex.' });
		}

		// Create a pristine 585x559 transparent PNG canvas (standard for classic Roblox clothing)
		let canvas = new Jimp(TEMPLATE_WIDTH, TEMPLATE_HEIGHT, 0x00000000);

		// Determine active UV panels based on Clothing Type and Sleeves/Shorts
		const activePanels = [];

		if (!isPants) {
			// Shirt: Always render torso
			activePanels.push(
				UV_PANELS.TORSO_TOP,
				UV_PANELS.TORSO_BOTTOM,
				UV_PANELS.TORSO_RIGHT,
				UV_PANELS.TORSO_FRONT,
				UV_PANELS.TORSO_LEFT,
				UV_PANELS.TORSO_BACK
			);

			if (sleeve === 'Long') {
				// Full arms + bottom cuffs
				activePanels.push(
					UV_PANELS.R_TOP, UV_PANELS.R_BOTTOM, UV_PANELS.R_RIGHT, UV_PANELS.R_FRONT, UV_PANELS.R_LEFT, UV_PANELS.R_BACK,
					UV_PANELS.L_TOP, UV_PANELS.L_BOTTOM, UV_PANELS.L_RIGHT, UV_PANELS.L_FRONT, UV_PANELS.L_LEFT, UV_PANELS.L_BACK
				);
			} else if (sleeve === 'Short') {
				// Half arms (64px height) without bottom cuffs so avatar skin is visible
				activePanels.push(
					UV_PANELS.R_TOP,
					{ x: UV_PANELS.R_RIGHT.x, y: UV_PANELS.R_RIGHT.y, w: 64, h: 64 },
					{ x: UV_PANELS.R_FRONT.x, y: UV_PANELS.R_FRONT.y, w: 64, h: 64 },
					{ x: UV_PANELS.R_LEFT.x,  y: UV_PANELS.R_LEFT.y,  w: 64, h: 64 },
					{ x: UV_PANELS.R_BACK.x,  y: UV_PANELS.R_BACK.y,  w: 64, h: 64 },
					UV_PANELS.L_TOP,
					{ x: UV_PANELS.L_RIGHT.x, y: UV_PANELS.L_RIGHT.y, w: 64, h: 64 },
					{ x: UV_PANELS.L_FRONT.x, y: UV_PANELS.L_FRONT.y, w: 64, h: 64 },
					{ x: UV_PANELS.L_LEFT.x,  y: UV_PANELS.L_LEFT.y,  w: 64, h: 64 },
					{ x: UV_PANELS.L_BACK.x,  y: UV_PANELS.L_BACK.y,  w: 64, h: 64 }
				);
			}
			// Sleeveless: Arms remain 100% transparent
		} else {
			// Pants: Waistband / pelvis + legs
			activePanels.push(
				UV_PANELS.TORSO_BOTTOM,
				{ x: UV_PANELS.TORSO_RIGHT.x, y: UV_PANELS.TORSO_RIGHT.y + 64, w: 64, h: 64 },
				{ x: UV_PANELS.TORSO_FRONT.x, y: UV_PANELS.TORSO_FRONT.y + 64, w: 128, h: 64 },
				{ x: UV_PANELS.TORSO_LEFT.x,  y: UV_PANELS.TORSO_LEFT.y + 64,  w: 64, h: 64 },
				{ x: UV_PANELS.TORSO_BACK.x,  y: UV_PANELS.TORSO_BACK.y + 64,  w: 128, h: 64 }
			);

			if (sleeve === 'Shorts') {
				// Shorts (64px height) without bottom cuffs
				activePanels.push(
					UV_PANELS.R_TOP,
					{ x: UV_PANELS.R_RIGHT.x, y: UV_PANELS.R_RIGHT.y, w: 64, h: 64 },
					{ x: UV_PANELS.R_FRONT.x, y: UV_PANELS.R_FRONT.y, w: 64, h: 64 },
					{ x: UV_PANELS.R_LEFT.x,  y: UV_PANELS.R_LEFT.y,  w: 64, h: 64 },
					{ x: UV_PANELS.R_BACK.x,  y: UV_PANELS.R_BACK.y,  w: 64, h: 64 },
					UV_PANELS.L_TOP,
					{ x: UV_PANELS.L_RIGHT.x, y: UV_PANELS.L_RIGHT.y, w: 64, h: 64 },
					{ x: UV_PANELS.L_FRONT.x, y: UV_PANELS.L_FRONT.y, w: 64, h: 64 },
					{ x: UV_PANELS.L_LEFT.x,  y: UV_PANELS.L_LEFT.y,  w: 64, h: 64 },
					{ x: UV_PANELS.L_BACK.x,  y: UV_PANELS.L_BACK.y,  w: 64, h: 64 }
				);
			} else {
				// Full length pants
				activePanels.push(
					UV_PANELS.R_TOP, UV_PANELS.R_BOTTOM, UV_PANELS.R_RIGHT, UV_PANELS.R_FRONT, UV_PANELS.R_LEFT, UV_PANELS.R_BACK,
					UV_PANELS.L_TOP, UV_PANELS.L_BOTTOM, UV_PANELS.L_RIGHT, UV_PANELS.L_FRONT, UV_PANELS.L_LEFT, UV_PANELS.L_BACK
				);
			}
		}

		// 1. Paint base color strictly inside active UV panels
		for (const panel of activePanels) {
			fillRectOnCanvas(canvas, panel, baseColorHex);
		}

		// 2. Composite optional pattern texture masked to active panels
		if (patternAssetId) {
			try {
				const patternImg = await fetchRobloxAssetImage(patternAssetId);
				if (patternImg) {
					patternImg.resize(TEMPLATE_WIDTH, TEMPLATE_HEIGHT);
					for (const panel of activePanels) {
						const crop = patternImg.clone().crop(panel.x, panel.y, panel.w, panel.h);
						canvas.composite(crop, panel.x, panel.y, {
							mode: Jimp.BLEND_MULTIPLY,
							opacitySource: 0.85,
							opacityDest: 1,
						});
					}
				}
			} catch (err) {
				console.warn(`Pattern asset ${patternAssetId} failed to load: ${err.message}`);
			}
		}

		// 3. Composite chest graphic decal onto front torso panel
		if (!isPants && graphicAssetId) {
			try {
				const graphicImg = await fetchRobloxAssetImage(graphicAssetId);
				if (graphicImg) {
					graphicImg.contain(UV_PANELS.TORSO_FRONT.w - 16, UV_PANELS.TORSO_FRONT.h - 16);
					canvas.composite(graphicImg, UV_PANELS.TORSO_FRONT.x + 8, UV_PANELS.TORSO_FRONT.y + 8);
				}
			} catch (err) {
				console.warn(`Graphic asset ${graphicAssetId} failed to load: ${err.message}`);
			}
		}

		// 4. Render all user custom shapes (Rect, Circle, Rounded) and freehand brush strokes
		if (Array.isArray(drawingStrokes)) {
			for (const stroke of drawingStrokes) {
				const tool = stroke.tool || stroke.shape;

				if (tool === 'Rectangle') {
					drawFilledRect(canvas, stroke.x, stroke.y, stroke.width, stroke.height, stroke.colorHex);
				} else if (tool === 'Circle') {
					drawFilledCircleOrEllipse(canvas, stroke.x, stroke.y, stroke.width, stroke.height, stroke.colorHex);
				} else if (tool === 'Rounded') {
					drawFilledRoundedRect(canvas, stroke.x, stroke.y, stroke.width, stroke.height, stroke.colorHex, 14);
				} else if (tool === 'Brush' || tool === 'Eraser') {
					if (!stroke.points || !Array.isArray(stroke.points)) continue;
					const isEraser = tool === 'Eraser';
					const radius = Math.max(1, Math.floor((stroke.size || 6) / 2));
					if (stroke.points.length === 1) {
						drawCircle(canvas, stroke.points[0].x, stroke.points[0].y, radius, stroke.colorHex, isEraser);
					} else {
						for (let i = 0; i < stroke.points.length - 1; i++) {
							drawLine(
								canvas,
								stroke.points[i].x,
								stroke.points[i].y,
								stroke.points[i + 1].x,
								stroke.points[i + 1].y,
								radius,
								stroke.colorHex,
								isEraser
							);
						}
					}
				}

				// If shape had an applied texture pattern, composite it over the shape bounds
				if (stroke.patternAssetId && (tool === 'Rectangle' || tool === 'Circle' || tool === 'Rounded')) {
					try {
						const patImg = await fetchRobloxAssetImage(stroke.patternAssetId);
						if (patImg) {
							patImg.resize(TEMPLATE_WIDTH, TEMPLATE_HEIGHT);
							const crop = patImg.clone().crop(
								Math.max(0, stroke.x),
								Math.max(0, stroke.y),
								Math.min(TEMPLATE_WIDTH - stroke.x, stroke.width),
								Math.min(TEMPLATE_HEIGHT - stroke.y, stroke.height)
							);
							canvas.composite(crop, stroke.x, stroke.y, {
								mode: Jimp.BLEND_MULTIPLY,
								opacitySource: 0.85,
								opacityDest: 1,
							});
						}
					} catch (err) {
						console.warn(`Shape pattern asset ${stroke.patternAssetId} failed to load: ${err.message}`);
					}
				}
			}
		}

		const fileName = `${exportCode}.png`;
		const filePath = path.join(RENDER_DIR, fileName);
		await canvas.writeAsync(filePath);

		const imageUrl = `${req.protocol}://${req.get('host')}/renders/${fileName}`;
		return res.json({ success: true, imageUrl });
	} catch (err) {
		console.error('Render error:', err);
		return res.status(500).json({ success: false, message: 'Render failed on the server.' });
	}
});

app.get('/health', (_req, res) => res.send('ok'));

app.listen(PORT, () => {
	console.log(`Outfit render server listening on port ${PORT}`);
});
