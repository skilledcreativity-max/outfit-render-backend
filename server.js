// Outfit Studio render backend
// Takes a design (base color hex, Roblox pattern asset id, Roblox graphic asset id, sleeve/pant type)
// and composites it into a real 585x559 PNG classic clothing template with accurate UV coordinates and transparency.

const express = require('express');
const Jimp = require('jimp');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const RENDER_DIR = path.join(__dirname, 'renders');
if (!fs.existsSync(RENDER_DIR)) {
	fs.mkdirSync(RENDER_DIR, { recursive: true });
}

// Serve finished PNGs statically at /renders/<code>.png
app.use('/renders', express.static(RENDER_DIR));

const TEMPLATE_WIDTH = 585;
const TEMPLATE_HEIGHT = 559;

// Official Roblox Classic Clothing Template UV Coordinate Boxes (585 x 559)
const UV_PANELS = {
	// Torso Panels (128x128 front/back, 64x128 sides, 128x64 top/bottom)
	TORSO_TOP:    { x: 164, y: 0,   w: 128, h: 64 },
	TORSO_BOTTOM: { x: 164, y: 192, w: 128, h: 64 },
	TORSO_RIGHT:  { x: 100, y: 64,  w: 64,  h: 128 },
	TORSO_FRONT:  { x: 164, y: 64,  w: 128, h: 128 },
	TORSO_LEFT:   { x: 292, y: 64,  w: 64,  h: 128 },
	TORSO_BACK:   { x: 356, y: 64,  w: 128, h: 128 },

	// Right Arm / Leg (x: 0..256, y: 284..540)
	R_TOP:        { x: 64,  y: 284, w: 64,  h: 64 },
	R_BOTTOM:     { x: 64,  y: 476, w: 64,  h: 64 },
	R_RIGHT:      { x: 0,   y: 348, w: 64,  h: 128 },
	R_FRONT:      { x: 64,  y: 348, w: 64,  h: 128 },
	R_LEFT:       { x: 128, y: 348, w: 64,  h: 128 },
	R_BACK:       { x: 192, y: 348, w: 64,  h: 128 },

	// Left Arm / Leg (x: 292..548, y: 284..540)
	L_TOP:        { x: 356, y: 284, w: 64,  h: 64 },
	L_BOTTOM:     { x: 356, y: 476, w: 64,  h: 64 },
	L_RIGHT:      { x: 292, y: 348, w: 64,  h: 128 },
	L_FRONT:      { x: 356, y: 348, w: 64,  h: 128 },
	L_LEFT:       { x: 420, y: 348, w: 64,  h: 128 },
	L_BACK:       { x: 484, y: 348, w: 64,  h: 128 },
};

function fillRectOnCanvas(canvas, rect, hexColor) {
	const block = new Jimp(rect.w, rect.h, hexColor);
	canvas.composite(block, rect.x, rect.y);
}

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
		const { exportCode, clothingType, sleeveType, baseColorHex, patternAssetId, graphicAssetId } = req.body;
		const isPants = clothingType === 'Pants';
		const sleeve = sleeveType || 'Long';

		if (!exportCode || !baseColorHex) {
			return res.status(400).json({ success: false, message: 'Missing exportCode or baseColorHex.' });
		}

		// Initialize 585x559 canvas with full alpha transparency
		const canvas = new Jimp(TEMPLATE_WIDTH, TEMPLATE_HEIGHT, 0x00000000);

		// Determine active UV panels based on Clothing Type and Sleeves/Shorts
		const activePanels = [];

		if (!isPants) {
			// Shirt: Torso panels are always active
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
				// Short arms (64px height) without bottom cuffs so avatar skin is visible
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

		// 3. Composite chest graphic onto front torso panel
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
