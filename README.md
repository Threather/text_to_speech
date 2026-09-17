# Speak

A text-to-speech page. Paste text, pick a voice, press play.

Live: https://threather.github.io/text_to_speech/

It runs in two modes:

| Mode | Voice | Works in | Cost |
|---|---|---|---|
| **Worker configured** | Real `en-CA-LiamNeural` (Azure) | Every browser, identical | Free tier: 500k chars/month |
| **Not configured** | Whatever the visitor's browser has | Varies per browser/OS | Free |

Out of the box it's in fallback mode. Follow the steps below to get Liam everywhere.

---

## Setup

### 1. Azure Speech resource

1. [portal.azure.com](https://portal.azure.com) → **Create a resource** → search **Speech** → Create.
2. Pick a region and note it (e.g. `eastus`). Choose pricing tier **F0** (free, 500k characters/month).
3. Once deployed: **Keys and Endpoint** → copy **KEY 1** and confirm the **Location/Region**.

A card on file is required even for the free tier. F0 does not auto-upgrade — it stops serving when you hit the cap.

### 2. Deploy the Worker

From the `worker/` folder:

```bash
npm install -g wrangler
```

```bash
npx wrangler login
```

Set your region and site origin in `wrangler.toml`, then store the key as a secret (never commit it):

```bash
npx wrangler secret put AZURE_KEY
```

```bash
npx wrangler deploy
```

Wrangler prints a URL like `https://liam-tts.your-name.workers.dev`. Copy it.

### 3. Connect the page

In `index.html`, near the top of the `<script>`:

```js
var WORKER_URL = 'https://liam-tts.your-name.workers.dev';
```

Commit and push. GitHub Pages redeploys automatically.

```bash
git add -A && git commit -m "Connect TTS worker" && git push
```

---

## Notes

**The key stays on Cloudflare.** It's a Wrangler secret, never in this repo. The page only
ever talks to the Worker.

**Lock down the origin.** `ALLOWED_ORIGIN` in `wrangler.toml` restricts who can call the
Worker. With `"*"` anyone who finds the URL can spend your Azure quota.

**Limits.** 5000 characters per request, enforced on both sides. Azure's own ceiling is
around 10k including SSML markup.

**Adding voices.** Any Azure neural voice name works — add it to `AZURE_VOICES` in
`index.html`. The full list is in Microsoft's Speech service voice documentation.

## Layout

```
index.html          the whole site
worker/
  src/index.js      Azure proxy
  wrangler.toml     region + allowed origin (no secrets)
```
