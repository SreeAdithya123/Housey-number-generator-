// POST /api/scan: reads the numbers off a Housie ticket photo with a vision
// model on OpenRouter. The API key only ever exists here, as the Cloudflare
// secret OPENROUTER_API_KEY; the browser sends the photo to this endpoint and
// never sees the key.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODELS = ['google/gemma-4-31b-it:free', 'qwen/qwen3.8-27b:free'];
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BODY_CHARS = 8_000_000;
const MAX_IMAGE_CHARS = 6_000_000;
const ATTEMPT_TIMEOUT_MS = 35_000;
const MAX_OUTPUT_TOKENS = 3000;

const PROMPT = `This image shows ONE Tambola (Housie, 90-ball) ticket: a grid of 3 rows and 9 columns. Each row holds exactly 5 numbers (the other 4 cells are blank), so there are 15 numbers in total. All numbers are between 1 and 90, and inside a row they increase from left to right.

List the numbers of each row from left to right, as digits. Skip blank cells and ignore anything that is not a number inside the grid (ticket number, serial number, price, logos, other text). If the image shows more than one ticket, read only the largest, most complete one.

Reply with exactly 3 lines and nothing else. Line 1 is the top row, line 2 the middle row, line 3 the bottom row. Separate the numbers with single spaces. Example of the format (illustration only):
2 21 40 71 83
17 36 52 62 88
8 26 47 63 74`;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function modelList(env) {
  const configured = (env.OPENROUTER_MODELS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_MODELS;
}

function replyText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p?.text || '').join('\n');
  return '';
}

export function parseRows(text) {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[a-z]*/gi, '')
    .replace(/^\s*(?:row|line)\s*\d\s*[:.)-]?\s*/gim, '');

  const rows = [];
  for (const line of cleaned.split('\n')) {
    const numbers = (line.match(/\d+/g) || [])
      .map(Number)
      .filter((n) => n >= 1 && n <= 90);
    if (numbers.length) rows.push(numbers);
  }
  return rows.length >= 3 ? rows.slice(0, 3) : null;
}

async function askModel(model, image, mediaType, apiKey) {
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${image}` } },
          ],
        }],
      }),
    });
  } catch (err) {
    return { ok: false, kind: 'unavailable', detail: `${model}: ${err.name}` };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body: handled by the status checks below
  }

  const status = data?.error?.code ?? res.status;
  if (!res.ok || data?.error) {
    const detail = `${model}: ${status} ${String(data?.error?.message || '').slice(0, 120)}`;
    if (status === 401 || status === 403) return { ok: false, kind: 'auth', detail };
    if (status === 429) return { ok: false, kind: 'rate_limited', detail };
    return { ok: false, kind: 'unavailable', detail };
  }

  const rows = parseRows(replyText(data));
  if (!rows) return { ok: false, kind: 'unreadable', detail: `${model}: reply had no 3 rows of numbers` };
  return { ok: true, rows, model: data.model || model };
}

const FAILURES = {
  auth: [502, "The AI service rejected this site's API key."],
  rate_limited: [429, 'The free AI models are busy right now. Try again in a minute.'],
  unreadable: [502, "The AI couldn't read numbers from this photo."],
  unavailable: [502, 'The AI service is unavailable right now.'],
};

export async function onRequestPost({ request, env }) {
  if (!env.OPENROUTER_API_KEY) {
    return json(503, { error: 'not_configured', message: 'AI scanning is not set up on this site.' });
  }

  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json(403, { error: 'forbidden', message: 'Cross-site requests are not allowed.' });
  }

  if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
    return json(415, { error: 'bad_request', message: 'Send the photo as JSON.' });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) {
    return json(413, { error: 'too_large', message: 'That photo is too large.' });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'bad_request', message: 'Invalid JSON.' });
  }

  const { image, mediaType } = body || {};
  if (typeof image !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image) || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return json(400, { error: 'bad_request', message: 'Send a JPEG, PNG or WebP photo as base64.' });
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return json(413, { error: 'too_large', message: 'That photo is too large.' });
  }

  const failures = [];
  for (const model of modelList(env)) {
    const result = await askModel(model, image, mediaType, env.OPENROUTER_API_KEY);
    if (result.ok) return json(200, { rows: result.rows, model: result.model });

    console.error('scan attempt failed:', result.detail);
    if (result.kind === 'auth') {
      const [status, message] = FAILURES.auth;
      return json(status, { error: 'upstream_auth', message });
    }
    failures.push(result.kind);
  }

  const kind = ['rate_limited', 'unreadable', 'unavailable'].find((k) => failures.includes(k));
  const [status, message] = FAILURES[kind];
  return json(status, { error: kind, message });
}
