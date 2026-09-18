# Project state — pick up from here

Last updated: 2026-09-18

## What this is

A text-to-speech reader. Paste text or a chapter link, pick a voice, press Speak. The
text is read aloud while the current word is highlighted.

**Live:** https://threather.github.io/text_to_speech/
**Repo:** https://github.com/Threather/text_to_speech

```
Browser  ──POST text──▶  Cloudflare Worker  ──▶  Google Cloud TTS
   ◀──────── wav ─────────────┘
```

The Worker exists to hold the API key, which cannot live in a public repo. It also
fetches pages (the browser can't, because of CORS) and keeps the shared usage counter.

## Current state: working, everything below verified live

**Voices** — 176 in one dropdown. All 30 Chirp 3 HD speakers × 4 English locales
(US/GB/AU/IN), plus Neural2, Studio, News/Polyglot, WaveNet, Standard, plus 8 in-browser
Kokoro voices. Default is `en-US-Chirp3-HD-Algieba`.

**Reading** — text is split on sentence boundaries without merging across paragraphs, so
the voice pauses naturally at each break. Playback starts in ~0.8s regardless of length,
because the first chunk is small and later chunks are fetched ahead of playback.

**Following along** — the current word is highlighted, finished paragraphs dim, and the
view scrolls to keep up. Clicking any paragraph replays it from its start.

**Loading from links** — one box plus a count. Set the count above 1 and the Worker walks
each page's "next chapter" link, so only the first URL is ever typed. After a load the box
auto-fills with whatever comes next, so it's Load → Speak → Load → Speak.

**History** — every chapter loaded is remembered in `localStorage`, with per-item delete
and Clear all, and a show/hide toggle. Click an entry to put that link back in the box.
Nothing leaves the browser.

**Chapter imagery** — a Generate images button in setup. A text model picks five
visually distinct moments and writes a prompt for each; flux-1-schnell draws them on
Cloudflare's GPUs. ~2s per image, ~13s for five. Free within the Workers AI daily
allowance. Results cache in IndexedDB keyed by a hash of the chapter, so pressing again
costs nothing. Images appear in a right-hand rail on desktop (closed by default, opened
from a count chip in the header, positioned so each sits level with its paragraph) and in
a bottom sheet below 1200px. Prompts describe place, light, weather and mood only, never
people or names — the source is a copyrighted novel, and empty landscapes look better than
mangled figures anyway.

**Usage meter** — characters left this month, read from the Worker so every visitor sees
the same number.

## Accounts and where things live

| Thing | Where | Notes |
|---|---|---|
| Google Cloud project | `ttss`, kevinpom1999@gmail.com | Cloud Text-to-Speech API enabled |
| Google API key | Google Cloud → APIs & Services → Credentials | restricted to Cloud TTS only |
| Cloudflare Worker | `tts`, https://tts.kevinpom1999.workers.dev | holds the key |
| Worker secrets | Cloudflare → tts → Settings → Variables and Secrets | `GOOGLE_KEY` (secret), `ALLOWED_ORIGIN` (text) |
| Worker KV | Cloudflare → tts → Bindings | variable `USAGE` → namespace `speak-usage` |
| GitHub Pages | repo Settings → Pages, main / root | auto-deploys on push |

Billing: Google free trial, $300 credit / 90 days from 2026-09-17, so it runs out around
**2026-12-16**. The account pauses rather than charging — the site stops working until
upgraded. Free tier after upgrading is 1M Neural2/WaveNet characters a month.

## TODO

- [ ] **Rotate the Google API key.** It was visible in a screenshot during setup. Delete
      it in Credentials, create a new one restricted to Cloud Text-to-Speech, update
      `GOOGLE_KEY` in Cloudflare.
- [ ] **Set a budget alert** — only matters once the trial ends and the account is
      upgraded, since a trial account cannot be charged. Billing → Budgets & alerts → $1.

## Worker endpoints

| Route | Does |
|---|---|
| `POST /` | `{text, voice, rate, pitch}` → `audio/wav` |
| `GET /fetch?url=` | one page → `{title, text, next}` |
| `GET /chain?url=&n=` | follows next-links → `{pages:[{url,title,text}], next}` |
| `GET /usage` | `{used, limit, shared}` |
| `POST /scenes` | `{text, count}` -> `[{para, prompt}]` (a text model picks the moments) |
| `POST /image` | `{prompt}` -> image bytes (flux-1-schnell on Workers AI) |

## How to change things

**The site** — push to `main`. GitHub Pages rebuilds in about a minute. Deploys lag, so
when checking that a change went live, poll for a string unique to the *new* build; a
string that also exists in the old one will match too early and fool you.

**The Worker** — there is no Node on the Windows machine, so no `wrangler`. Use the
dashboard: Cloudflare → Workers & Pages → `tts` → **Edit code** → Ctrl+A → paste
`worker/src/index.js` → **Deploy**.

**Voices** — `VOICE_GROUPS` in `index.html`. Any name from
https://cloud.google.com/text-to-speech/docs/voices works. Kokoro voices use a `kokoro:`
prefix and run in the browser instead.

**Default voice** — `DEFAULT_VOICE` in `index.html`.

**Timing** — `FIRST_CHUNK` (220 chars, small so playback starts fast), `CHUNK` (700),
`LOOKAHEAD` (2 chunks fetched ahead of playback).

## Things that bit us — don't redo these

**Microsoft Liam is not obtainable.** It's an Azure cloud voice. The Windows "natural
voice" packs can't be redistributed — they're licensed to the machine they're installed
on. Edge exposes online voices to the Web Speech API, but only for Edge-on-Windows
visitors, which fails the "same voice everywhere" requirement.

**Azure is unavailable in Cambodia.** No Cambodia in the signup country list. Google Cloud
has it. That's why this runs on Google.

**ElevenLabs was tried and dropped.** Better voices, but 10k characters/month free and
~$22/month for roughly seven chapters. Google gives 1M free. The ElevenLabs Worker is in
git history at `f79b45e` if it's ever worth revisiting.

**Audio encoding matters — use LINEAR16.** Google's plain `MP3` is 32kbps and audibly
dulls the HD voices; confirmed by ear against the same line both ways. `MP3_64_KBPS`
exists only in the v1beta1 API and returns 400 on v1. LINEAR16 at 24kHz is the model's own
output — about 12x larger, no compression loss.

**Kokoro does not work on iOS.** The model load stalls indefinitely with no error. The
same page on desktop works fine. Treat the in-browser voices as desktop-only; the 86MB
download also misses any reasonable time-to-first-audio on mobile.

**iOS Safari needs the audio element unlocked during the tap.** Generation is async, so by
playback time the user gesture is gone. The page plays a silent clip synchronously inside
the click handler. Every iOS browser is WebKit, so this covers Chrome/Firefox/Edge there
too. Verified working on a real device.

**The Worker's voice-name regex silently swallows bad names** — an unmatched voice falls
back to `DEFAULT_VOICE` instead of erroring, so a typo sounds like the wrong voice rather
than failing. This hid every Chirp 3 HD voice for a while.

**Chirp voices reject `pitch`.** The Worker omits it for them.

**A single-chapter load has to use `/chain`, not `/fetch`.** Only `/chain` reports the
next chapter, which is what auto-continue depends on.

**Patch scripts mangle regex literals.** Writing `\n` inside a Python replacement string
put a real newline into a JS regex and broke the page twice. Use raw strings, and run a
brace-balance check on the script before pushing.

**Workers AI retires models on a schedule.** `@cf/meta/llama-3.1-8b-instruct` was
deprecated 2026-05-30 and returned a hard 5028. The Worker now names several text models
and uses whichever the account serves, remembering the winner.

**Each Workers AI model takes its own parameter shape.** flux-1-schnell accepts
`{prompt, steps}` and rejects `negative_prompt`/`num_steps` with a 5006 — unknown
params are an error, not a warning. Hence the per-model candidate list in drawImage, and
why the "no people" instruction lives in the prompt text as well.

**flux returns JPEG bytes, not PNG.** The endpoint still labels them image/png; browsers
sniff and render it fine, but a download gets a mislabelled extension. Worth fixing on the
next Worker redeploy.

**Scene JSON is not reliable.** parseScenes tries a bare array, a fenced array and a
wrapped object; if all fail, fallbackScenes picks evenly spaced paragraphs so the button
cannot dead-end.

**KV reads are edge-cached** for up to a minute, so a fresh count can read stale. The
counter is also read-modify-write, so simultaneous requests can lose an increment. It's a
meter, not an invoice — Billing Reports is authoritative.

## Performance

Measured live, 1152 characters, Google voice: **0.81s to first audio**, 3 chunks, gapless,
no errors. Worker responds in ~0.5s per chunk. A 3-chapter chain load pulled 20,714
characters across 152 paragraphs.

## Layout

```
index.html           the whole site
worker/src/index.js  Google TTS proxy + page reader + usage counter
worker/wrangler.toml only needed if deploying with the CLI
README.md            setup instructions
NOTES.md             this file
```
