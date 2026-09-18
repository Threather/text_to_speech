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

// ── Reader mode: pull the readable text out of a web page ──────────────
// The browser can't fetch other origins itself, so this does it here.

const MAX_PAGE_BYTES = 3_000_000;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t ]+/g, ' ').trim();
}

// Block anything that isn't a public web page, so this can't be used to probe
// internal addresses.
function safeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') ||
    /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.test(h) &&
      (/^(10|127|0)\./.test(h) || /^192\.168\./.test(h) ||
       /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) ||
    h === '[::1]'
  ) return null;
  return u;
}

// Walk forward from an opening tag to its matching close, counting nesting.
function sliceBalanced(html, openEnd, tag) {
  const re = new RegExp(`<(/?)${tag}\\b`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(openEnd, m.index);
  }
  return null;
}

// Pick the block that holds the most actual prose. Footers, comment sections and
// "next chapter" widgets lose because they carry little paragraph text.
function mainContent(html) {
  const re = /<(div|article|section|main)\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*(?:chapter|content|article|entry|post|story|reading|text)[^"']*["'][^>]*>/gi;
  let best = null, bestScore = 0, m;

  while ((m = re.exec(html))) {
    const inner = sliceBalanced(html, m.index + m[0].length, m[1]);
    if (!inner) continue;
    let score = 0;
    for (const p of inner.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) score += p[1].length;
    if (score > bestScore) { bestScore = score; best = inner; }
  }
  return bestScore > 400 ? best : html;
}

// Site furniture that shows up inside or right after the text on reader sites.
const JUNK = [
  /if you find any errors/i,
  /please let us know so we can fix/i,
  /use arrow keys/i,
  /prev\s*\/\s*next chapter/i,
  /loading comments/i,
  /keep discussions friendly/i,
  /comments that break these rules/i,
  /enter your account email/i,
  /we'?ll send a reset link/i,
  /^\s*(advertisement|sponsored|report (a |this )?(chapter|error))\s*$/i,
  /^(next|previous|prev) chapter$/i,
  /translator|editor:|proofread/i,
];

const isJunk = t => JUNK.some(re => re.test(t));

async function readPage(raw) {
  const u = safeUrl(raw);
  if (!u) throw new Error('That URL is not a public web address.');

  const r = await fetch(u.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SpeakReader/1.0)',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en',
    },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`The page returned ${r.status}.`);

  const type = r.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(type)) {
    throw new Error('That link is not an HTML page.');
  }

  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_PAGE_BYTES) throw new Error('That page is too large.');
  let html = new TextDecoder('utf-8').decode(buf);

  // Drop everything that never contains prose.
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|noscript)[\s\S]*?<\/\1>/gi, ' ');

  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);

  // Narrow to the block that actually holds the prose before reading paragraphs.
  const body = mainContent(html);

  // Collect paragraphs. Short ones that are mostly links are navigation, not text.
  const paras = [];
  for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const inner = m[1];
    const text = stripTags(inner);
    if (!text || isJunk(text)) continue;
    if (/<a\b/i.test(inner) && text.length < 60) continue;
    paras.push(text);
  }

  // Some sites use <div> per line instead of <p>.
  if (paras.length < 3) {
    for (const m of body.matchAll(/<div\b[^>]*>([^<]{40,})<\/div>/gi)) {
      const text = stripTags(m[1]);
      if (text && !isJunk(text)) paras.push(text);
    }
  }

  if (!paras.length) throw new Error('No readable text found on that page.');
  return { title, text: paras.join('\n\n'), next: findNext(html, u) };
}

// Find the "next chapter" link so a whole run can be pulled from one starting URL.
function findNext(html, base) {
  const rel = html.match(/<(?:link|a)\b[^>]*\brel\s*=\s*["']?next["']?[^>]*>/i);
  if (rel) {
    const href = (rel[0].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (href) return absolute(href, base);
  }

  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const text = stripTags(m[2]);
    const href = (attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href || href.startsWith('#') || /javascript:/i.test(href)) continue;
    // "Next chapter", "next >", or a link whose id/class says next.
    if (/^next\b/i.test(text) || /\bnext\b/i.test(attrs)) return absolute(href, base);
  }
  return null;
}

function absolute(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

// Follow the chain of next-links, collecting each chapter in order.
async function readChain(startUrl, count) {
  const out = [];
  const seen = new Set();
  let url = startUrl;

  for (let i = 0; i < count && url; i++) {
    if (seen.has(url)) break;          // a site that links back on itself
    seen.add(url);
    const page = await readPage(url);
    out.push({ title: page.title, text: page.text });
    url = page.next;
  }

  if (!out.length) throw new Error('Nothing could be read from that link.');
  return out;
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const headers = cors(allowed);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    const origin = request.headers.get('Origin');
    if (allowed !== '*' && origin && origin !== allowed) {
      return new Response('Forbidden origin', { status: 403, headers });
    }

    if (url.pathname === '/chain') {
      try {
        const n = Math.min(15, Math.max(1, parseInt(url.searchParams.get('n'), 10) || 1));
        const pages = await readChain(url.searchParams.get('url') || '', n);
        return new Response(JSON.stringify(pages), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(e.message, { status: 400, headers });
      }
    }

    if (url.pathname === '/fetch') {
      try {
        const data = await readPage(url.searchParams.get('url') || '');
        return new Response(JSON.stringify(data), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(e.message, { status: 400, headers });
      }
    }

    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers });

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
