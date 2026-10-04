// Ticket scanning: turns a photo of a Housie/Tambola ticket into a 3 x 9 grid
// by sending it to /api/scan, a Cloudflare Function that asks a vision model
// (via OpenRouter) to read the numbers. The API key lives only on the server.
//
// If the scanner is unavailable (not deployed, no key, throttled, offline) the
// caller gets an empty grid and the reason, so the host can type the numbers
// in. There is deliberately no on-device OCR fallback: it was measured at 1 of
// 15 numbers on a real ticket, and a plausible-looking wrong read is worse
// than an empty grid.

import { ROWS, COLS, gridFromRows, checkTicket } from './ticket-rules.js';
import { accessToken } from './backend.js';

const SCAN_ENDPOINT = 'api/scan';
const AI_MAX_DIMENSION = 1600;
const AI_TIMEOUT_MS = 75_000;

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    img.src = url;
  });
}

function drawToCanvas(img, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

function emptyGrid() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

/**
 * Asks /api/scan whether it exists and can see its API key, without scanning.
 * Resolves to 'ready', 'no_key', 'not_deployed' or 'offline'.
 */
export async function checkAiScanner() {
  let res;
  try {
    res = await fetch(SCAN_ENDPOINT, { signal: AbortSignal.timeout(8000) });
  } catch {
    return 'offline';
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // a host without the function answers with an HTML page or a 404
  }
  if (!res.ok || data?.ok !== true) return 'not_deployed';
  return data.configured ? 'ready' : 'no_key';
}

function isRowsPayload(rows) {
  return Array.isArray(rows) && rows.length === ROWS
    && rows.every((row) => Array.isArray(row) && row.every((n) => Number.isInteger(n) && n >= 1 && n <= 90));
}

async function scanWithAi(canvas, onProgress) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const image = dataUrl.slice(dataUrl.indexOf(',') + 1);

  let token = null;
  try {
    token = await accessToken();
  } catch {
    // treated the same as being signed out
  }
  if (!token) throw new Error('Sign in as admin to scan tickets.');

  onProgress?.(0.2, 'Asking the AI to read the ticket…');
  let res;
  try {
    res = await fetch(SCAN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ image, mediaType: 'image/jpeg' }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Couldn't reach the AI scanner.");
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON (for example a static host with no /api/scan): handled below
  }

  if (!res.ok) {
    if ([404, 405, 501].includes(res.status)) throw new Error("The AI scanner isn't deployed on this site (no /api/scan).");
    if (data?.error === 'not_configured') throw new Error('The AI scanner has no API key on the server yet.');
    throw new Error(data?.message || 'The AI scan failed.');
  }
  if (!isRowsPayload(data?.rows)) throw new Error('The AI scanner sent back something unexpected.');

  onProgress?.(0.95, 'Checking the numbers…');
  return { rows: data.rows, model: data.model };
}

/**
 * Scans a ticket photo. Resolves to
 *   { grid, source: 'ai' | 'none', model?, fallbackReason?, flags, notes }
 * where grid is 3x9 (null = blank), flags lists cells that look misread
 * ({ row, col, reason }) and notes are row-level warnings. source 'none'
 * means the scan failed: grid is empty and fallbackReason says why.
 * Rejects only if the file is not a readable image.
 * onProgress(fraction 0..1, label) is called as the scan proceeds.
 */
export async function scanTicketImage(file, onProgress) {
  onProgress?.(0.02, 'Reading the photo…');
  const { img, url } = await fileToImage(file);

  try {
    const { rows, model } = await scanWithAi(drawToCanvas(img, AI_MAX_DIMENSION), onProgress);
    const { grid, flags: placement } = gridFromRows(rows);
    const { flags, notes } = checkTicket(grid, placement);
    onProgress?.(1, 'Done');
    return { grid, source: 'ai', model, flags, notes };
  } catch (err) {
    onProgress?.(1, 'Done');
    return { grid: emptyGrid(), source: 'none', fallbackReason: err.message, flags: [], notes: [] };
  } finally {
    URL.revokeObjectURL(url);
  }
}
