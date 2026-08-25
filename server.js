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

// Official Roblox Classic Clothing Template UV Coordinate Boxes (585 x 559)
const TEMPLATE_OVERLAYS = {
	Shirt: 'https://static.wikia.nocookie.net/roblox/images/d/d5/Template-Shirts-R15_07072020.png',
	Pants: 'https://static.wikia.nocookie.net/roblox/images/0/07/Template-Pants-R15_07072020.png',
};

// Official Roblox R15 Template Pixel-Perfect UV Coordinates (585 x 559)
const UV_PANELS = {
	// Torso (Seamless Y span: 28 -> 92 -> 220 -> 284)
	TORSO_TOP:    { x: 231, y: 28,  w: 128, h: 64 },
	TORSO_RIGHT:  { x: 167, y: 92,  w: 64,  h: 128 },
	TORSO_FRONT:  { x: 231, y: 92,  w: 128, h: 128 },
	TORSO_LEFT:   { x: 359, y: 92,  w: 64,  h: 128 },
	TORSO_BACK:   { x: 423, y: 92,  w: 128, h: 128 },
	TORSO_BOTTOM: { x: 231, y: 220, w: 128, h: 64 },

	// Right Arm / Right Leg (Seamless Y span: 284 -> 348 -> 476 -> 540)
	R_TOP:        { x: 213, y: 284, w: 64,  h: 64 },
	R_RIGHT:      { x: 21,  y: 348, w: 64,  h: 128 },
	R_FRONT:      { x: 85,  y: 348, w: 64,  h: 128 },
	R_LEFT:       { x: 149, y: 348, w: 64,  h: 128 },
	R_BACK:       { x: 213, y: 348, w: 64,  h: 128 },
	R_BOTTOM:     { x: 213, y: 476, w: 64,  h: 64 },

	// Left Arm / Left Leg (Seamless Y span: 284 -> 348 -> 476 -> 540)
	L_TOP:        { x: 277, y: 284, w: 64,  h: 64 },
	L_RIGHT:      { x: 277, y: 348, w: 64,  h: 128 },
	L_FRONT:      { x: 341, y: 348, w: 64,  h: 128 },
	L_LEFT:       { x: 405, y: 348, w: 64,  h: 128 },
	L_BACK:       { x: 469, y: 348, w: 64,  h: 128 },
	L_BOTTOM:     { x: 277, y: 476, w: 64,  h: 64 },
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

		// Load official Roblox template image as the base canvas
		const localTemplatePath = path.join(__dirname, 'templates', isPants ? 'pants_template.png' : 'shirt_template.png');
		let canvas;

		if (fs.existsSync(localTemplatePath)) {
			canvas = await Jimp.read(localTemplatePath);
		} else {
			const templateUrl = isPants ? OFFICIAL_TEMPLATES.Pants : OFFICIAL_TEMPLATES.Shirt;
			const templateResponse = await axios.get(templateUrl, {
				responseType: 'arraybuffer',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
					'Accept': 'image/png,image/*;q=0.8',
				},
				timeout: 15000,
			});
			canvas = await Jimp.read(Buffer.from(templateResponse.data));
		}

		canvas.resize(TEMPLATE_WIDTH, TEMPLATE_HEIGHT);

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

		// 4. Render all user custom drawings and paint strokes directly onto the template
		if (Array.isArray(drawingStrokes)) {
			for (const stroke of drawingStrokes) {
				if (!stroke.points || !Array.isArray(stroke.points)) continue;
				const isEraser = stroke.tool === 'Eraser';
				const radius = Math.max(1, Math.floor((stroke.size || 6) / 2));
				for (const pt of stroke.points) {
					drawCircle(canvas, pt.x, pt.y, radius, stroke.colorHex, isEraser);
				}
			}
		}

		// 5. Composite official Roblox template outline and labels on top
		const templateOverlayUrl = isPants ? TEMPLATE_OVERLAYS.Pants : TEMPLATE_OVERLAYS.Shirt;
		try {
			const overlayResponse = await axios.get(templateOverlayUrl, { responseType: 'arraybuffer', timeout: 10000 });
			const overlayImg = await Jimp.read(Buffer.from(overlayResponse.data));
			overlayImg.resize(TEMPLATE_WIDTH, TEMPLATE_HEIGHT);
			canvas.composite(overlayImg, 0, 0, {
				mode: Jimp.BLEND_SOURCE_OVER,
				opacitySource: 0.9,
				opacityDest: 1,
			});
		} catch (err) {
			console.warn(`Failed to composite template overlay: ${err.message}`);
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
