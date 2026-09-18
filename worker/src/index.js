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

// Google's free tier, shared by everyone using this Worker.
const FREE_LIMIT = 1000000;

const usageKey = () => {
  const d = new Date();
  return `chars:${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
};

// Read-modify-write on KV, so two requests landing together can lose a count.
// The meter is an estimate, not an invoice — Billing Reports is the real number.
async function addUsage(env, n) {
  if (!env.USAGE) return;
  try {
    const key = usageKey();
    const cur = parseInt(await env.USAGE.get(key), 10) || 0;
    await env.USAGE.put(key, String(cur + n), { expirationTtl: 60 * 60 * 24 * 70 });
  } catch (e) {}
}

async function getUsage(env) {
  if (!env.USAGE) return { used: 0, limit: FREE_LIMIT, shared: false };
  const used = parseInt(await env.USAGE.get(usageKey()), 10) || 0;
  return { used, limit: FREE_LIMIT, shared: true };
}

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
    out.push({ url, title: page.title, text: page.text });
    url = page.next;
  }

  if (!out.length) throw new Error('Nothing could be read from that link.');
  // `url` is now whatever came after the last chapter read, so the caller can
  // pick up from there next time.
  return { pages: out, next: url };
}

// ── Chapter imagery, on Cloudflare's own GPUs ──────────────────────────
// Two steps so pictures arrive one at a time instead of as one huge payload:
//   POST /scenes  {text, count} -> [{para, prompt}]   (a text model reads the chapter)
//   POST /image   {prompt}      -> image/png          (SDXL-Lightning draws one)
//
// The scene prompts describe PLACE, LIGHT, WEATHER and MOOD only, never a
// person or a named figure: the source text is someone's copyrighted novel,
// and atmosphere is both the safe answer and the better-looking one.

// Cloudflare retires models on a schedule, so name several and use whichever
// this account actually serves. First one that answers wins, and the winner is
// remembered for the life of the isolate.
const TEXT_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3-8b-instruct',
];
const IMAGE_MODELS = [
  '@cf/black-forest-labs/flux-1-schnell',
  '@cf/bytedance/stable-diffusion-xl-lightning',
  '@cf/stabilityai/stable-diffusion-xl-base-1.0',
];

let goodText = null, goodImage = null;

async function runFirst(env, models, remembered, input, setter) {
  const order = remembered ? [remembered].concat(models.filter(m => m !== remembered)) : models;
  let last = 'no model available';
  for (const m of order) {
    try {
      const out = await env.AI.run(m, input);
      setter(m);
      return { model: m, out };
    } catch (e) {
      last = (e && e.message) || String(e);
      // A deprecated or unavailable model is worth skipping; anything else is
      // a real failure and retrying other models just wastes the allowance.
      if (!/deprecat|not found|no such model|unavailable|5028|7000|7001/i.test(last)) throw e;
    }
  }
  throw new Error(last);
}

const MAX_SCENE_TEXT = 12000;   // plenty for a chapter; keeps the model prompt sane
const MAX_SCENES = 5;

const SCENE_RULES =
  'You are given a passage of prose. Choose the most visually distinct moments in it ' +
  'and write one image prompt for each.\n\n' +
  'HARD RULES:\n' +
  '- Describe only PLACE, ARCHITECTURE, LANDSCAPE, WEATHER, LIGHT, OBJECTS and MOOD.\n' +
  '- Never describe a person, character, figure, creature or any living being. No faces, no bodies, no silhouettes of people.\n' +
  '- Never use a proper name from the text.\n' +
  '- No lettering, no logos, no captions in the image.\n' +
  '- 12 to 30 words each. Concrete nouns and light, not plot.\n' +
  '- Each prompt must depict a different location or time of day from the others.\n\n' +
  'Return ONLY a JSON array, no prose around it, in this exact shape:\n' +
  '[{"para":0,"prompt":"..."}]\n' +
  'where "para" is the 0-based index of the paragraph the moment belongs to.';

function paragraphsOf(text) {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}

// The model is asked for bare JSON but will sometimes wrap it in prose or a
// code fence, so pull the first array out rather than trusting the envelope.
function parseScenes(raw, paraCount, want) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw || '');
  let out = [];

  // The model is asked for a bare array but will variously wrap it in a code
  // fence, in prose, or in an object. Try each shape rather than trusting one.
  const attempts = [];
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) attempts.push(arr[0]);
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) attempts.push(obj[0]);

  for (const a of attempts) {
    try {
      let v = JSON.parse(a);
      if (v && !Array.isArray(v)) v = v.scenes || v.moments || v.images || v.results;
      if (Array.isArray(v) && v.length) { out = v; break; }
    } catch (e) { /* try the next shape */ }
  }

  return out
    .filter(s => s && typeof s.prompt === 'string' && s.prompt.trim())
    .map(s => ({
      para: Math.min(paraCount - 1, Math.max(0, parseInt(s.para, 10) || 0)),
      prompt: s.prompt.trim().slice(0, 300),
    }))
    .slice(0, want);
}

// If the model will not produce usable JSON, the feature still works: take
// evenly spaced paragraphs and build a prompt from the concrete words in each.
// Worse images than a model-written prompt, but never a dead button.
function fallbackScenes(paras, want) {
  const step = Math.max(1, Math.floor(paras.length / want));
  const out = [];
  for (let i = 0; i < paras.length && out.length < want; i += step) {
    const words = paras[i].replace(/["'\u2018\u2019\u201c\u201d]/g, ' ')
      .split(/\s+/).filter(w => w.length > 3).slice(0, 26).join(' ');
    if (words.length > 20) out.push({ para: i, prompt: words.slice(0, 300) });
  }
  return out;
}

async function buildScenes(env, text, want) {
  const paras = paragraphsOf(text);
  if (!paras.length) throw new Error('No text to read.');

  // Number the paragraphs so the model can point at one.
  const numbered = paras
    .map((p, i) => `[${i}] ${p}`)
    .join('\n\n')
    .slice(0, MAX_SCENE_TEXT);

  const { out } = await runFirst(env, TEXT_MODELS, goodText, {
    messages: [
      { role: 'system', content: SCENE_RULES },
      { role: 'user', content: `Choose ${want} moments from this passage.\n\n${numbered}` },
    ],
    max_tokens: 900,
  }, m => { goodText = m; });

  const raw = out && (out.response !== undefined ? out.response : (out.result !== undefined ? out.result : out));
  let scenes = parseScenes(raw, paras.length, want);

  if (!scenes.length) scenes = fallbackScenes(paras, want);
  if (!scenes.length) {
    throw new Error('No usable scenes. Model said: ' + String(raw).slice(0, 200));
  }
  return scenes;
}

async function drawImage(env, prompt) {
  // A house style, so five images from one chapter read as one set. The "no
  // people" instruction lives in the prompt as well as the negative prompt,
  // because flux accepts no negative prompt at all.
  const styled =
    prompt +
    ', atmospheric matte painting, muted warm palette, volumetric light, ' +
    'deep shadow, painterly, empty landscape, no people, no figures, no text';

  const NEG = 'people, person, face, figure, crowd, text, watermark, signature, logo, letters';

  // Each model takes its own parameter shape; sending the wrong one is a hard
  // 5006 rather than a warning, so they are declared per model.
  const candidates = [
    { model: '@cf/black-forest-labs/flux-1-schnell', input: { prompt: styled, steps: 4 } },
    { model: '@cf/bytedance/stable-diffusion-xl-lightning',
      input: { prompt: styled, negative_prompt: NEG, num_steps: 8 } },
    { model: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
      input: { prompt: styled, negative_prompt: NEG, num_steps: 20 } },
  ];

  const order = goodImage
    ? candidates.slice().sort((a, b) => (a.model === goodImage ? -1 : b.model === goodImage ? 1 : 0))
    : candidates;

  let last = 'no image model available';
  for (const c of order) {
    try {
      const out = await env.AI.run(c.model, c.input);
      goodImage = c.model;
      // Some models stream raw PNG bytes; flux returns base64 in JSON.
      if (out && typeof out === 'object' && typeof out.image === 'string') {
        return b64ToBytes(out.image);
      }
      return out;
    } catch (e) {
      last = (e && e.message) || String(e);
      if (!/deprecat|not found|no such model|unavailable|not allowed|5006|5028|7000|7001/i.test(last)) throw e;
    }
  }
  throw new Error(last);
}

export default {
  async fetch(request, env, ctx) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const headers = cors(allowed);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    const origin = request.headers.get('Origin');
    if (allowed !== '*' && origin && origin !== allowed) {
      return new Response('Forbidden origin', { status: 403, headers });
    }

    if (url.pathname === '/scenes') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405, headers });
      if (!env.AI) return new Response('Workers AI is not bound to this Worker', { status: 500, headers });
      try {
        const b = await request.json();
        const want = Math.min(MAX_SCENES, Math.max(1, parseInt(b.count, 10) || 5));
        const scenes = await buildScenes(env, String(b.text || ''), want);
        return new Response(JSON.stringify(scenes), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(e.message || 'Scene selection failed', { status: 502, headers });
      }
    }

    if (url.pathname === '/image') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405, headers });
      if (!env.AI) return new Response('Workers AI is not bound to this Worker', { status: 500, headers });
      try {
        const b = await request.json();
        const prompt = String(b.prompt || '').trim().slice(0, 300);
        if (!prompt) return new Response('No prompt', { status: 400, headers });
        const png = await drawImage(env, prompt);
        return new Response(png, {
          headers: { ...headers, 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        return new Response(e.message || 'Image generation failed', { status: 502, headers });
      }
    }

    if (url.pathname === '/usage') {
      return new Response(JSON.stringify(await getUsage(env)), {
        headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/chain') {
      try {
        const n = Math.min(15, Math.max(1, parseInt(url.searchParams.get('n'), 10) || 1));
        const result = await readChain(url.searchParams.get('url') || '', n);
        return new Response(JSON.stringify(result), {
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

    // Count against the shared free tier. Done off the response path so it
    // never slows playback.
    ctx.waitUntil(addUsage(env, text.length));

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
