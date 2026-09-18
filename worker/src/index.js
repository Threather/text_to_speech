/**
 * Cloudflare Worker — Google Cloud Text-to-Speech proxy.
 *
 * Holds the API key so it never reaches the public site.
 * POST { text, voice, rate, pitch } -> audio/mpeg
 *
 * Secrets / vars:
 *   GOOGLE_KEY     - secret: npx wrangler secret put GOOGLE_KEY
 *   ALLOWED_ORIGIN - your site's origin; "*" allows anyone (don't ship that)
 */

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// Google's own cap is 5000 bytes per request. The page sends much smaller chunks.
const MAX_CHARS = 4500;
const DEFAULT_VOICE = 'en-US-Neural2-D';

// Only allow Google voice names, so the key can't be used for arbitrary calls.
// Covers en-US-Neural2-D, en-US-Studio-Q, en-US-Polyglot-1 and the longer
// multi-part names like en-US-Chirp3-HD-Charon.
const VOICE_RE = /^[a-z]{2}-[A-Z]{2}(?:-[A-Za-z0-9]+){1,3}$/;

const cors = origin => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

// Google returns base64; the page wants raw audio bytes.
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const headers = cors(allowed);

    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers });

    const origin = request.headers.get('Origin');
    if (allowed !== '*' && origin && origin !== allowed) {
      return new Response('Forbidden origin', { status: 403, headers });
    }

    if (!env.GOOGLE_KEY) {
      return new Response('Worker is missing GOOGLE_KEY', { status: 500, headers });
    }

    let body;
    try { body = await request.json(); }
    catch { return new Response('Invalid JSON', { status: 400, headers }); }

    const text = (body.text || '').trim();
    if (!text) return new Response('No text', { status: 400, headers });
    if (text.length > MAX_CHARS) {
      return new Response(`Too long (max ${MAX_CHARS})`, { status: 413, headers });
    }

    const voice = VOICE_RE.test(body.voice || '') ? body.voice : DEFAULT_VOICE;
    const languageCode = voice.split('-').slice(0, 2).join('-');

    // Google takes rate as a multiplier and pitch in semitones.
    const speakingRate = Math.min(2, Math.max(0.5, Number(body.rate) || 1));
    const pitch = Math.min(20, Math.max(-20, Number(body.pitch) || 0));

    // Chirp voices reject pitch outright, so only send it to the families
    // that accept it.
    // MP3 here is 32kbps and audibly dulls the HD voices (MP3_64_KBPS is
    // v1beta1-only). LINEAR16 is the model's own output — bigger, but exact.
    const audioConfig = { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate };
    if (pitch && !voice.includes('Chirp')) audioConfig.pitch = pitch;

    const upstream = await fetch(`${ENDPOINT}?key=${env.GOOGLE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voice },
        audioConfig,
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      // Don't echo the whole payload back — it can contain the key in error URLs.
      let msg = `Google error ${upstream.status}`;
      try { msg += ': ' + (JSON.parse(detail).error?.message || ''); } catch {}
      return new Response(msg.slice(0, 300), { status: 502, headers });
    }

    const data = await upstream.json();
    if (!data.audioContent) return new Response('No audio returned', { status: 502, headers });

    return new Response(b64ToBytes(data.audioContent), {
      headers: { ...headers, 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
    });
  },
};
