# Speak

A text-to-speech page. Paste text, pick a voice, press play.

Live: https://threather.github.io/text_to_speech/

Audio is synthesized by Google Cloud Text-to-Speech and streamed back in chunks, so
playback starts in about a second regardless of how long the text is. Nothing is
downloaded to the visitor's device and no voice needs to be installed, so it behaves the
same in Chrome, Firefox, Safari and on iOS.

```
Browser  ──POST text──▶  Cloudflare Worker  ──▶  Google Cloud TTS
   ◀──────── mp3 ─────────────┘
```

The Worker exists solely to hold the API key. A key in `index.html` would be public.

## Setup

### 1. Google Cloud

1. [Create a project](https://console.cloud.google.com/projectcreate).
2. Enable the [Cloud Text-to-Speech API](https://console.cloud.google.com/apis/library/texttospeech.googleapis.com).
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Open the key → **Restrict key** → **Cloud Text-to-Speech API** → Save.

Free tier is 1M Neural2/WaveNet characters per month. Set a budget alert under
**Billing → Budgets & alerts** — the free tier does not hard-stop once billing is active.

### 2. Cloudflare Worker (no install needed)

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) — free, no card.
2. **Workers & Pages → Create → Start with Hello World → Deploy**.
3. **Edit code**, replace everything with [`worker/src/index.js`](worker/src/index.js), **Deploy**.
4. **Settings → Variables and Secrets**:
   - Secret `GOOGLE_KEY` = your API key
   - Variable `ALLOWED_ORIGIN` = `https://threather.github.io`
5. Copy the Worker URL (`https://<name>.<subdomain>.workers.dev`).

### 3. Connect

In `index.html`, set:

```js
var WORKER_URL = 'https://your-worker.workers.dev';
```

Commit and push; GitHub Pages redeploys automatically.

## Notes

**The key never enters this repo.** It lives only as a Worker secret. `ALLOWED_ORIGIN`
stops other sites from calling your Worker and spending your quota.

**Chunking** — text is split on sentence boundaries. The first chunk is small
(`FIRST_CHUNK`, 220 chars) so audio starts quickly; later chunks are larger (`CHUNK`)
and fetched `LOOKAHEAD` ahead of playback, so there are no gaps.

**iOS** — every iOS browser uses WebKit, which only allows playback started by a user
gesture. The page primes the audio element with a silent clip during the tap on Speak,
which keeps it playable for the rest of the session.

**Voices** — the `VOICES` array in `index.html`. Any Google voice name works. Avoid
`Studio` voices unless you want them: much better quality, roughly 10x the price and a
smaller free tier.

**Without a Worker** the page falls back to the browser's own voices, which differ per
device. That's the setup banner you'll see if `WORKER_URL` is blank.

## Layout

```
index.html          the whole site
worker/src/index.js the Google TTS proxy
worker/wrangler.toml optional, only if deploying with the CLI
```
