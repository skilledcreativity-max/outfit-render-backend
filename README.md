# Outfit Studio Render Backend

Turns a player's design (base color, pattern, chest graphic) into a real,
downloadable PNG shirt template. Roblox's Luau has no image library, so this
piece has to live outside the game.

## 1. Run it locally first (optional sanity check)

```
npm install
npm start
```

Then test it:

```
curl -X POST http://localhost:3000/render \
  -H "Content-Type: application/json" \
  -d '{"exportCode":"TEST1234","baseColorHex":"#2D3436","patternAssetId":"","graphicAssetId":""}'
```

You should get back `{"success":true,"imageUrl":"http://localhost:3000/renders/TEST1234.png"}`.

## 2. Deploy it somewhere public

Roblox's game servers need to reach this over the public internet. Easiest
free options:

- **Render.com** — "New Web Service" → connect this folder/repo → build
  command `npm install`, start command `npm start`. Free tier works fine to
  start.
- **Railway.app** — similar one-click deploy from a repo.
- Any VPS running Node 18+ also works.

Once deployed, you'll get a public URL like `https://your-app.onrender.com`.

## 3. Point your Roblox game at it

In `ExportServer.server.lua`, set:

```lua
local RENDER_API_URL = "https://your-app.onrender.com/render"
```

In Roblox Studio, go to **Game Settings → Security** and turn **on**
"Allow HTTP Requests" — without this, `HttpService:RequestAsync` calls will
fail silently.

## Known limitations (worth knowing)

- **Chest graphic placement is an approximation.** `CHEST_REGION` in
  `server.js` is a reasonable guess at the front-torso area on the classic
  585x559 template, not pixel-verified against Roblox's official template
  guide. For exact alignment, download Roblox's blank shirt template from
  the upload page and use it as the base layer instead of a flat color fill.
- **Free hosting tiers sleep when idle** — the first render request after
  inactivity can take 10-30 seconds to "wake up." The Roblox-side script
  already treats this as a normal (if slow) response, but consider a paid
  tier if this becomes annoying for players.
- **Rendered files persist on disk indefinitely** — for a real game you'll
  want a cron job or storage service (S3, etc.) with expiry, so `/renders`
  doesn't grow forever.
