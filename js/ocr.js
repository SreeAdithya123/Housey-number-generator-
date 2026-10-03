// Ticket scanning: turns a photo of a Housie/Tambola ticket into a 3 x 9 grid.
//
// 1. Preferred: send the photo to /api/scan, a Cloudflare Function that asks a
//    vision model (via OpenRouter) to read the numbers. The API key lives only
//    on the server.
// 2. Fallback: if that is unavailable (not configured, rate limited, offline),
//    run Tesseract OCR in the browser. It works offline but misreads often, so
//    the result is flagged for the host to double check.
//
// Either way the caller gets a grid plus the cells that look wrong, because
// no automatic read of a phone photo can be trusted blindly.

import { ROWS, COLS, gridFromRows, checkTicket } from './ticket-rules.js';

const SCAN_ENDPOINT = 'api/scan';
const AI_MAX_DIMENSION = 1600;
const AI_TIMEOUT_MS = 75_000;

// Everything Tesseract.js needs (main script, worker, WASM core, English
// trained data) is vendored under js/vendor/tesseract instead of pulled from
// a CDN at runtime: that keeps the app installable/offline-capable and
// means the OCR step never depends on a third-party CDN being reachable.
const VENDOR_BASE = 'js/vendor/tesseract';
const TESSERACT_SCRIPT = `${VENDOR_BASE}/tesseract.min.js`;
const WORKER_PATH = `${VENDOR_BASE}/worker.min.js`;
const CORE_PATH = `${VENDOR_BASE}/core`;
const LANG_PATH = `${VENDOR_BASE}/lang-data`;
const OCR_MAX_DIMENSION = 1400;

let tesseractLoadPromise = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoadPromise) return tesseractLoadPromise;

  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TESSERACT_SCRIPT;
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => reject(new Error('Could not load the OCR engine. Try reloading the page.'));
    document.head.appendChild(script);
  });

  return tesseractLoadPromise;
}

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

// ---------------- AI scan ----------------

function isRowsPayload(rows) {
  return Array.isArray(rows) && rows.length === ROWS
    && rows.every((row) => Array.isArray(row) && row.every((n) => Number.isInteger(n) && n >= 1 && n <= 90));
}

async function scanWithAi(canvas, onProgress) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const image = dataUrl.slice(dataUrl.indexOf(',') + 1);

  onProgress?.(0.2, 'Asking the AI to read the ticket…');
  let res;
  try {
    res = await fetch(SCAN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const notDeployed = [404, 405, 501].includes(res.status) || data?.error === 'not_configured';
    throw new Error(notDeployed ? "AI scanning isn't set up on this site yet." : data?.message || 'The AI scan failed.');
  }
  if (!isRowsPayload(data?.rows)) throw new Error('The AI scanner sent back something unexpected.');

  onProgress?.(0.95, 'Checking the numbers…');
  return { rows: data.rows, model: data.model };
}

// ---------------- Tesseract fallback ----------------

function emptyGrid() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function placeWord(grid, text, cx, cy, width, height) {
  const value = parseInt(text.replace(/\D/g, ''), 10);
  if (!Number.isFinite(value) || value < 1 || value > 90) return;

  const row = Math.min(ROWS - 1, Math.max(0, Math.floor((cy / height) * ROWS)));
  const col = Math.min(COLS - 1, Math.max(0, Math.floor((cx / width) * COLS)));

  if (grid[row][col] == null) grid[row][col] = value;
}

function walkBlocksForWords(blocks) {
  const words = [];
  (blocks || []).forEach((block) => {
    (block.paragraphs || []).forEach((para) => {
      (para.lines || []).forEach((line) => {
        (line.words || []).forEach((word) => {
          if (word && word.text && word.bbox) words.push(word);
        });
      });
    });
  });
  return words;
}

function gridFromWords(words, width, height) {
  const grid = emptyGrid();
  words.forEach((word) => {
    const { x0, x1, y0, y1 } = word.bbox;
    placeWord(grid, word.text, (x0 + x1) / 2, (y0 + y1) / 2, width, height);
  });
  return grid;
}

function gridFromPlainText(text) {
  // No position data available: distribute numbers from each non-empty
  // line left-to-right across the row they most likely belong to.
  const grid = emptyGrid();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const numericLines = lines.filter((l) => /\d/.test(l)).slice(0, ROWS);

  numericLines.forEach((line, rowIdx) => {
    const matches = (line.match(/\d{1,2}/g) || [])
      .map((n) => parseInt(n, 10))
      .filter((n) => n >= 1 && n <= 90);
    const colStep = COLS / Math.max(matches.length, 1);
    matches.forEach((value, i) => {
      const col = Math.min(COLS - 1, Math.round(i * colStep));
      if (grid[rowIdx][col] == null) grid[rowIdx][col] = value;
    });
  });

  return grid;
}

async function scanWithTesseract(canvas, onProgress) {
  onProgress?.(0.1, 'Loading the offline OCR engine…');
  const Tesseract = await loadTesseract();

  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.(0.2 + m.progress * 0.75, 'Recognizing numbers…');
      }
    },
  });

  try {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '11', // sparse text: good fit for a grid of isolated numbers
    });
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
    const words = walkBlocksForWords(data.blocks);
    return words.length ? gridFromWords(words, canvas.width, canvas.height) : gridFromPlainText(data.text || '');
  } finally {
    await worker.terminate();
  }
}

/**
 * Scans a ticket photo. Resolves to
 *   { grid, source: 'ai' | 'ocr', model?, fallbackReason?, flags, notes }
 * where grid is 3x9 (null = blank), flags lists cells that look misread
 * ({ row, col, reason }) and notes are row-level warnings.
 * onProgress(fraction 0..1, label) is called as the scan proceeds.
 */
export async function scanTicketImage(file, onProgress) {
  onProgress?.(0.02, 'Reading the photo…');
  const { img, url } = await fileToImage(file);

  try {
    let fallbackReason;
    try {
      const { rows, model } = await scanWithAi(drawToCanvas(img, AI_MAX_DIMENSION), onProgress);
      const { grid, flags: placement } = gridFromRows(rows);
      const { flags, notes } = checkTicket(grid, placement);
      onProgress?.(1, 'Done');
      return { grid, source: 'ai', model, flags, notes };
    } catch (err) {
      fallbackReason = err.message;
    }

    const grid = await scanWithTesseract(drawToCanvas(img, OCR_MAX_DIMENSION), onProgress);
    const { flags, notes } = checkTicket(grid);
    onProgress?.(1, 'Done');
    return { grid, source: 'ocr', fallbackReason, flags, notes };
  } finally {
    URL.revokeObjectURL(url);
  }
}
