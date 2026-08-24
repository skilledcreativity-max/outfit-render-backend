// Outfit Studio render backend
// Takes a design (base color hex, Roblox pattern asset id, Roblox graphic asset id)
// and composites it into a real 585x559 PNG shirt template that players can download.
//
// Deploy this somewhere with a public URL (see README.md), then point your Roblox
// ServerScript's RENDER_API_URL at it.

const express = require('express');
const Jimp = require('jimp');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const RENDER_DIR = path.join(__dirname, 'renders');
if (!fs.existsSync(RENDER_DIR)) fs.mkdirSync(RENDER_DIR);

// Serve finished PNGs statically at /renders/<code>.png
app.use('/renders', express.static(RENDER_DIR));

const TEMPLATE_WIDTH = 585;
const TEMPLATE_HEIGHT = 559;

// Confirmed from Roblox's official docs (create.roblox.com/docs/en-us/avatar/classic-clothing):
//   Front / Back panels  : 128 x 128
//   Torso & arm sides    : 64 x 128
//   Up / Down panels     : 128 x 64
//   Arm/leg caps         : 64 x 64
// Roblox's docs give panel SIZES but not their exact x/y offsets on the canvas — those
// live inside the official template file itself. Download it here and use it as your
// true source of truth for exact placement:
//   https://create.roblox.com/docs/assets/accessories/classic-clothing/Classic-Clothing-Templates.zip
// The box below is a reasonable approximation of the FRONT panel's position, good enough
// for a solid base color (which covers every panel identically), but you should verify
// it against the real official template before relying on exact chest-graphic placement —
// open the downloaded template in an image editor, check the FRONT square's pixel
// coordinates, and update x/y/w/h here to match exactly.
const CHEST_REGION = { x: 195, y: 140, w: 195, h: 195 };

async function fetchRobloxAssetImage(assetId) {
	if (!assetId) return null;
	// assetdelivery serves the raw image bytes for texture/decal-type assets.
	const url = `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`;
	const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
	return Jimp.read(Buffer.from(response.data));
}

app.post('/render', async (req, res) => {
	try {
		const { exportCode, baseColorHex, patternAssetId, graphicAssetId } = req.body;

		if (!exportCode || !baseColorHex) {
			return res.status(400).json({ success: false, message: 'Missing exportCode or baseColorHex.' });
		}

		const canvas = new Jimp(TEMPLATE_WIDTH, TEMPLATE_HEIGHT, baseColorHex);

		if (patternAssetId) {
			try {
				const patternImg = await fetchRobloxAssetImage(patternAssetId);
				if (patternImg) {
					patternImg.resize(TEMPLATE_WIDTH, TEMPLATE_HEIGHT);
					canvas.composite(patternImg, 0, 0, {
						mode: Jimp.BLEND_MULTIPLY,
						opacitySource: 0.85,
						opacityDest: 1,
					});
				}
			} catch (err) {
				console.warn(`Pattern asset ${patternAssetId} failed to load: ${err.message}`);
				// Non-fatal: continue rendering without the pattern layer.
			}
		}

		if (graphicAssetId) {
			try {
				const graphicImg = await fetchRobloxAssetImage(graphicAssetId);
				if (graphicImg) {
					graphicImg.contain(CHEST_REGION.w, CHEST_REGION.h);
					canvas.composite(graphicImg, CHEST_REGION.x, CHEST_REGION.y);
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
