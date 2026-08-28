Outfit Studio Renderer Production Runbook

The hardened code is not self-deploying. Complete every step below in a staging environment before enabling a Limited Roblox playtest.

1. Create private object storage

Create a private S3-compatible bucket dedicated to outfit-studio-renders. Disable public bucket access. Give the renderer identity permission only to put objects under renders/ and generate signed GetObject links. Do not use a public /renders directory.

Apply s3-lifecycle.json to the bucket. The supplied rule deletes rendered files after one day; the download link itself expires after 15 minutes by default. If you change either period, update the privacy notice and user-facing export message.

2. Configure the renderer service

Create a new service from this directory. Set the environment variables from .env.example in the host’s secret manager; never commit a populated .env file. Generate RENDER_API_KEY using a password manager or a cryptographic generator. Configure the host’s HTTP health-check path as /health.

For a broad public release, put the service behind a managed edge layer that provides TLS, DDoS protection, request-size enforcement, web-application firewall rules, and IP-based rate limiting. The in-process limit in server.js is only a second line of defense. Run at least two workers behind a shared storage service; do not attach a single-instance local disk as output storage.

3. Configure Roblox production secrets

In Creator Dashboard, create a secret named outfit_render_api_key for the exact renderer domain and set it to the same value as RENDER_API_KEY. Replace these constants in OutfitStudioServer_Hardened.server.luau before publishing:

Constant
Production value
RENDER_API_URL
The HTTPS /render endpoint for this exact deployed renderer.
RENDER_DOWNLOAD_PREFIX
The exact HTTPS host/path prefix used by your signed object-storage downloads.
RENDER_SECRET_NAME
outfit_render_api_key, unless you deliberately use another Creator Dashboard secret name.
APPROVED_PATTERN_ASSET_IDS
Only the numeric IDs you are permitted to use.
APPROVED_GRAPHIC_ASSET_IDS
Only pre-approved graphic IDs. Leave empty until you have a documented approval and moderation workflow.




Enable Allow HTTP Requests only after the secret and exact endpoint are configured. Do not insert any secret value in a LocalScript, ModuleScript replicated to clients, DataStore, or source-control file.

4. Run pre-release gates

Run these commands from the renderer folder in clean CI and before every release:

Bash


npm ci --ignore-scripts
npm run audit
npm test



The current suite verifies authentication, malformed requests, oversized-body rejection, asset allowlists, canonical mask containment, and representative shape output. Extend it with golden PNG fixtures covering every player-visible tool, sleeve type, garment type, and graphic transform before public launch.

5. Operate a Limited playtest first

Keep the Roblox experience Private while validating secrets and external storage. Then enable a Limited playtest audience, set low render quotas, and monitor authentication failures, invalid payloads, queue depth, render duration, image-fetch failures, object-store errors, and per-user export rate. Do not make the game broadly public until the service has passed controlled concurrency and outage tests with real players.

6. Establish policy and support controls

Provide a visible in-game notice that generated PNGs are subject to Roblox moderation and that exporting does not guarantee Marketplace acceptance. Publish a privacy notice that explains short output retention. Add a report/contact route for copyrighted or prohibited designs, retain only the minimal security logs needed for incident review, and document operator response procedures before granting unrestricted public export access.

Publish decision criteria

You may move from Private to a Limited playtest only when all configuration steps above are complete and npm run audit plus npm test pass in the exact deployed build. You may move from Limited playtest to public beta only after real-load, failure, and moderation gates succeed. Do not claim readiness for a massive launch until multi-worker capacity, external monitoring, cost controls, incident response, and content-moderation operations have been exercised under progressively larger traffic.

