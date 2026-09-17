# Speak

A text-to-speech page. Paste text, pick a voice, press play.

Live: https://threather.github.io/text_to_speech/

Everything runs in the visitor's browser. No server, no API key, no account, no
per-request cost. Text is never uploaded anywhere.

## How it works

[Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) is an 82M-parameter
neural TTS model. The page loads it with
[kokoro-js](https://www.npmjs.com/package/kokoro-js) and runs inference in WebAssembly.

The quantized model is ~86MB, fetched from the Hugging Face CDN on first visit and cached
by the browser afterwards. It isn't committed here — that keeps the repo small and avoids
GitHub's 100MB file limit.

Because the model ships with the page rather than coming from the visitor's OS, **every
visitor hears the same voice** — Chrome, Firefox, Safari, mobile, and offline after the
first load.

## Editing

**Voices** — the `VOICES` array in `index.html`. Kokoro has ~50; the eight clearest English
ones are listed. Prefixes: `a` American, `b` British, `m` male, `f` female.

**Length cap** — `MAX`, currently 2000 characters. Longer text works but generation time
scales with it.

**Quality vs. size** — `dtype: 'q8'` is the quantized model. `'fp32'` is better quality at
roughly 4x the download.

## Deploying

It's a single static file. Push to `main` and GitHub Pages redeploys.

```bash
git add -A && git commit -m "Update" && git push
```

## Why not the Microsoft Liam voice

Liam is an Azure cloud voice. Using it means an Azure subscription, an API key, and a
server-side proxy to hold that key — and Azure signup isn't available in every country.
The Windows "natural voice" packs can't be redistributed either; they're licensed to the
machine they're installed on.

Kokoro is Apache-2.0 licensed and free to host, which is why it's here.
