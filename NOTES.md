# Project state — pick up from here

Last updated: 2026-09-17

## What this is

A text-to-speech site. Paste text, pick a voice, press Speak.

**Live:** https://threather.github.io/text_to_speech/
**Repo:** https://github.com/Threather/text_to_speech

## Current state: working, done

71 voices in one dropdown, from two different sources:

| Source | Voices | Speed | Cost |
|---|---|---|---|
| Google Cloud TTS (via Cloudflare Worker) | 63 | ~1s to first audio | free, 1M chars/month |
| Kokoro (runs in the browser) | 8 | 86MB download first use | free, no limit |

Google voices are grouped: Chirp 3 HD (newest/best), Neural2, Studio, News/Polyglot,
WaveNet, Standard. The in-browser group is Michael, Adam, Echo, George, Lewis, Heart,
Bella, Emma.

The 86MB Kokoro model **only downloads if you pick one of those 8 voices**. Google voices
download nothing.

## Accounts and where things live

| Thing | Where | Notes |
|---|---|---|
| Google Cloud project | `ttss`, account kevinpom1999@gmail.com | Cloud Text-to-Speech API enabled |
| Google API key | Google Cloud → APIs & Services → Credentials | restricted to Cloud TTS only |
| Cloudflare Worker | `tts`, https://tts.kevinpom1999.workers.dev | holds the key |
| Worker secrets | Cloudflare → tts → Settings → Variables and Secrets | `GOOGLE_KEY` (secret), `ALLOWED_ORIGIN` (text) |
| GitHub Pages | repo Settings → Pages, main / root | auto-deploys on push |

Billing: Google free trial, $300 credit / 90 days from 2026-09-17. Free tier afterwards is
1M Neural2/WaveNet chars/month. **Trial expiry ~2026-12-16** — the account pauses rather
than charging, so the site would stop working until upgraded.

## TODO

- [ ] **Rotate the Google API key.** It was visible in a screenshot during setup. Delete it
      in Credentials, create a new one restricted to Cloud Text-to-Speech, update
      `GOOGLE_KEY` in Cloudflare.
- [ ] **Set a budget alert.** Billing → Budgets & alerts → $1, alerts at 50% / 100%.
      The free tier does not hard-stop once billing is active.
- [ ] **Test on iOS Safari.** The autoplay fix is written but never verified on a real
      device. If it fails you'll see "Your browser blocked autoplay. Tap Speak again."
- [ ] Pick a default voice and set `DEFAULT_VOICE` in `index.html`.

## How to change things

**Deploying the site** — push to `main`. GitHub Pages rebuilds automatically, takes about
a minute.

**Deploying the Worker** — there is no Node on the Windows machine, so no `wrangler`.
Do it through the dashboard: Cloudflare → Workers & Pages → `tts` → **Edit code** →
Ctrl+A → paste `worker/src/index.js` → **Deploy**.

**Adding voices** — `VOICE_GROUPS` near the top of the script in `index.html`. Any Google
voice name from https://cloud.google.com/text-to-speech/docs/voices works. Kokoro voices
use a `kokoro:` prefix.

**Chunking / speed** — `FIRST_CHUNK` (220 chars, kept small so playback starts fast),
`CHUNK` (700), `LOOKAHEAD` (2 chunks fetched ahead of playback).

## Things that bit us — don't redo these

**Microsoft Liam is not obtainable.** It's an Azure cloud voice. The Windows "natural
voice" packs can't be redistributed — they're licensed to the machine. Edge exposes online
voices to the Web Speech API, but only for Edge-on-Windows visitors.

**Azure is unavailable in Cambodia.** The signup country list has no Cambodia. Google Cloud
does. This is why the project runs on Google.

**ElevenLabs was tried and dropped.** Voice quality is better (Alexander), but the free tier
is 10k chars/month and $22/mo only buys ~7 chapters. Google gives 1M free. The ElevenLabs
Worker code is in git history at commit `f79b45e` if it's ever worth revisiting.

**The Worker's voice-name regex silently swallows bad names.** An unmatched voice falls
back to `DEFAULT_VOICE` instead of erroring, so a typo sounds like the wrong voice rather
than failing. This hid the Chirp 3 HD voices for a while.

**Chirp voices reject `pitch`.** The Worker omits it for them.

**iOS Safari needs the audio element unlocked during the tap.** Generation is async, so by
playback time the user gesture is gone. The page plays a silent clip synchronously inside
the click handler to keep the element playable. Every iOS browser is WebKit, so this covers
Chrome/Firefox/Edge on iOS too.

**`speechSynthesis.getVoices()` returns empty on first call** in every browser. The fallback
path listens for `voiceschanged`.

## Performance

Measured on the live site, 1152 characters, Google voice: **0.81s to first audio**, 3 chunks,
gapless, no errors. Worker responds in ~0.5s per chunk.

Kokoro on a phone is much worse — roughly 40-100s before first audio (86MB download, WASM
init, then slow inference) with a risk of the tab running out of memory. Use Google voices
on mobile.

## Layout

```
index.html           the whole site
worker/src/index.js  Google TTS proxy (deploy via Cloudflare dashboard)
worker/wrangler.toml only needed if using the CLI
README.md            setup instructions
NOTES.md             this file
```
