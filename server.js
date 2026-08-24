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

// Derived exactly from Roblox's official template (create.roblox.com/docs/en-us/avatar/classic-clothing):
// panel sizes are Front/Back 128x128, torso sides (R/L) 64x128, Up/Down 128x64.
// The torso row reads left-to-right as R | FRONT | L | BACK (64+128+64+128 = 384px),
// centered in the 585px canvas (100.5px margin each side), with UP/DOWN stacked directly
// above/below FRONT. This gives FRONT's exact bounding box — no guessing required:
//   R:    x=100, y=64,  w=64,  h=128
//   FRONT: x=164, y=64,  w=128, h=128   <- used below for the chest graphic
//   L:    x=292, y=64,  w=64,  h=128
//   BACK:  x=356, y=64,  w=128, h=128
//   UP:    x=164, y=0,   w=128, h=64
//   DOWN:  x=164, y=192, w=128, h=64
const CHEST_REGION = { x: 164, y: 64, w: 128, h: 128 };

async function fetchRobloxAssetImage(assetId) {
	if (!assetId) return null;

	// Roblox now blocks direct, unauthenticated asset downloads (assetdelivery.roblox.com
	// returns 401/403 for server-to-server requests). The public workaround is the
	// Thumbnails API, which returns a usable rendered-image URL without authentication.
	// On a thumbnail's very first request, Roblox generates it asynchronously and
	// returns state "Pending" — so we retry a few times with a short delay.
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
