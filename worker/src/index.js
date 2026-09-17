/**
 * Cloudflare Worker — ElevenLabs text-to-speech proxy.
 *
 * Holds the API key so it never reaches the public site.
 *
 *   POST /         { text, voice, speed } -> audio/mpeg
 *   GET  /voices                          -> [{ id, name, category }]
 *
 * The voice list is proxied so the page always shows the voices actually in your
 * ElevenLabs library, with the right IDs — no hardcoding.
 *
 * Secrets / vars:
 *   ELEVEN_KEY     - secret, your ElevenLabs API key
 *   ELEVEN_MODEL   - optional, defaults to eleven_multilingual_v2
 *   ALLOWED_ORIGIN - your site's origin; "*" allows anyone (don't ship that)
 */

const API = 'https://api.elevenlabs.io/v1';
const MAX_CHARS = 4000;

// Quality default. eleven_turbo_v2_5 is faster and uses fewer credits;
// eleven_flash_v2_5 is cheapest and fastest but noticeably flatter.
const DEFAULT_MODEL = 'eleven_multilingual_v2';

// ElevenLabs voice IDs are 20-char alphanumeric strings.
const VOICE_RE = /^[A-Za-z0-9]{16,32}$/;

const cors = origin => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const headers = cors(allowed);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    if (!env.ELEVEN_KEY) {
      return new Response('Worker is missing ELEVEN_KEY', { status: 500, headers });
    }

    const origin = request.headers.get('Origin');
    if (allowed !== '*' && origin && origin !== allowed) {
      return new Response('Forbidden origin', { status: 403, headers });
    }

    // ── Voice list ────────────────────────────────────────────
    if (url.pathname === '/voices') {
      const r = await fetch(`${API}/voices`, { headers: { 'xi-api-key': env.ELEVEN_KEY } });
      if (!r.ok) {
        return new Response(`Could not list voices (${r.status})`, { status: 502, headers });
      }
      const data = await r.json();
      const voices = (data.voices || []).map(v => ({
        id: v.voice_id,
        name: v.name,
        category: v.category || 'other',
      }));
      return new Response(JSON.stringify(voices), {
        headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
      });
    }

    // ── Synthesis ─────────────────────────────────────────────
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers });

    let body;
    try { body = await request.json(); }
    catch { return new Response('Invalid JSON', { status: 400, headers }); }

    const text = (body.text || '').trim();
    if (!text) return new Response('No text', { status: 400, headers });
    if (text.length > MAX_CHARS) {
      return new Response(`Too long (max ${MAX_CHARS})`, { status: 413, headers });
    }

    const voice = body.voice || '';
    if (!VOICE_RE.test(voice)) return new Response('Bad voice id', { status: 400, headers });

    // ElevenLabs has no pitch control; speed lives in voice_settings.
    const speed = Math.min(1.2, Math.max(0.7, Number(body.speed) || 1));

    const r = await fetch(`${API}/text-to-speech/${voice}`, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVEN_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: env.ELEVEN_MODEL || DEFAULT_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed },
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      let msg = `ElevenLabs error ${r.status}`;
      try {
        const j = JSON.parse(detail);
        msg += ': ' + (j.detail?.message || j.detail?.status || j.detail || '');
      } catch {}
      // 401 = bad key, 429 = out of credits. Both are worth saying plainly.
      if (r.status === 401) msg = 'ElevenLabs rejected the API key.';
      if (r.status === 429) msg = 'Out of ElevenLabs credits for this month.';
      return new Response(msg.slice(0, 300), { status: 502, headers });
    }

    return new Response(r.body, {
      headers: { ...headers, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  },
};
