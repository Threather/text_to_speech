/**
 * Cloudflare Worker: Azure Neural TTS proxy.
 *
 * Keeps AZURE_KEY off the public site. The page POSTs {text, voice, rate, pitch}
 * and gets back audio/mpeg.
 *
 * Secrets / vars (see wrangler.toml and README):
 *   AZURE_KEY     - secret, set with: npx wrangler secret put AZURE_KEY
 *   AZURE_REGION  - e.g. "eastus"
 *   ALLOWED_ORIGIN- your Pages origin; "*" allows anyone (don't ship that)
 */

const MAX_CHARS = 5000;          // Azure's own cap per request is ~10k incl. SSML
const DEFAULT_VOICE = 'en-CA-LiamNeural';

// Only let callers pick real Azure voice names, not arbitrary strings.
const VOICE_RE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// SSML is XML — unescaped text breaks the request or injects markup.
function escapeXml(s) {
  return s.replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const headers = cors(allowed);

    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405, headers });
    }

    // Reject cross-site callers early so the key can't be borrowed by other pages.
    const origin = request.headers.get('Origin');
    if (allowed !== '*' && origin && origin !== allowed) {
      return new Response('Forbidden origin', { status: 403, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers });
    }

    const text = (body.text || '').trim();
    if (!text) return new Response('No text', { status: 400, headers });
    if (text.length > MAX_CHARS) {
      return new Response(`Too long (max ${MAX_CHARS} characters)`, { status: 413, headers });
    }

    const voice = VOICE_RE.test(body.voice || '') ? body.voice : DEFAULT_VOICE;
    const rate  = Math.min(2, Math.max(0.5, Number(body.rate)  || 1));
    const pitch = Math.min(50, Math.max(-50, Number(body.pitch) || 0));

    // Azure wants rate as a percentage delta from normal.
    const ratePct = Math.round((rate - 1) * 100);

    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
      `<voice name="${voice}">` +
      `<prosody rate="${ratePct >= 0 ? '+' : ''}${ratePct}%" pitch="${pitch >= 0 ? '+' : ''}${pitch}%">` +
      escapeXml(text) +
      `</prosody></voice></speak>`;

    const endpoint =
      `https://${env.AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const azure = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': env.AZURE_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'tts-site',
      },
      body: ssml,
    });

    if (!azure.ok) {
      const detail = await azure.text();
      return new Response(
        `Azure error ${azure.status}: ${detail.slice(0, 300)}`,
        { status: 502, headers }
      );
    }

    return new Response(azure.body, {
      headers: {
        ...headers,
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  },
};
