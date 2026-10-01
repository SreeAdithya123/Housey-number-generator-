// Ticket OCR: reads a photographed Housie/Tambola ticket (a 3 row x 9 column
// grid where each row has 5 numbers and 4 blanks) and returns a best-effort
// digital copy of it. OCR on a real photo is never perfect, so the caller
// always gets an editable grid back; this module's job is just to get a
// good first guess, not a guaranteed-correct read.

// Everything Tesseract.js needs (main script, worker, WASM core, English
// trained data) is vendored under js/vendor/tesseract instead of pulled from
// a CDN at runtime: that keeps the app installable/offline-capable and
// means the OCR step never depends on a third-party CDN being reachable.
const VENDOR_BASE = 'js/vendor/tesseract';
const TESSERACT_SCRIPT = `${VENDOR_BASE}/tesseract.min.js`;
const WORKER_PATH = `${VENDOR_BASE}/worker.min.js`;
const CORE_PATH = `${VENDOR_BASE}/core`;
const LANG_PATH = `${VENDOR_BASE}/lang-data`;

const ROWS = 3;
const COLS = 9;
const MAX_DIMENSION = 1400;

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

function drawToCanvas(img) {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
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

function placeWord(grid, counts, text, cx, cy, width, height) {
  const value = parseInt(text.replace(/\D/g, ''), 10);
  if (!Number.isFinite(value) || value < 1 || value > 90) return;

  const row = Math.min(ROWS - 1, Math.max(0, Math.floor((cy / height) * ROWS)));
  const col = Math.min(COLS - 1, Math.max(0, Math.floor((cx / width) * COLS)));

  if (grid[row][col] == null) {
    grid[row][col] = value;
    counts[row][col] = 1;
  }
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
  const counts = emptyGrid().map((row) => row.map(() => 0));
  words.forEach((word) => {
    const { x0, x1, y0, y1 } = word.bbox;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    placeWord(grid, counts, word.text, cx, cy, width, height);
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

/**
 * Scans a ticket photo and returns { grid }, a 3x9 array (null = blank cell).
 * onProgress(fraction 0..1, label) is called as OCR proceeds.
 */
export async function scanTicketImage(file, onProgress) {
  onProgress?.(0, 'Loading OCR engine…');
  const Tesseract = await loadTesseract();

  onProgress?.(0.05, 'Reading image…');
  const { img, url } = await fileToImage(file);
  let canvas;
  try {
    canvas = drawToCanvas(img);
  } finally {
    URL.revokeObjectURL(url);
  }

  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.(0.1 + m.progress * 0.85, 'Recognizing numbers…');
      }
    },
  });

  let grid;
  try {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '11', // sparse text: good fit for a grid of isolated numbers
    });
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
    const words = walkBlocksForWords(data.blocks);
    grid = words.length ? gridFromWords(words, canvas.width, canvas.height) : gridFromPlainText(data.text || '');
  } finally {
    await worker.terminate();
  }

  onProgress?.(1, 'Done');
  return { grid };
}
