// Small DOM-building and feedback helpers shared by app.js. No framework,
// no build step: this stays a plain static site so it installs and runs
// anywhere, including straight off GitHub Pages.

const ROWS = 3;
const COLS = 9;

export function buildEditableGrid(grid, flags = []) {
  const el = document.createElement('div');
  el.className = 'ticket-grid';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.maxLength = 2;
      input.className = 'ticket-cell';
      input.dataset.row = String(r);
      input.dataset.col = String(c);
      const v = grid[r][c];
      input.value = v == null ? '' : String(v);

      const flag = flags.find((f) => f.row === r && f.col === c);
      if (flag) {
        input.classList.add('warn');
        input.title = flag.reason;
      }

      input.addEventListener('input', () => {
        input.value = input.value.replace(/[^0-9]/g, '').slice(0, 2);
        input.classList.remove('warn');
        input.removeAttribute('title');
      });
      el.appendChild(input);
    }
  }
  return el;
}

export function readGridFromDom(gridEl) {
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  gridEl.querySelectorAll('.ticket-cell').forEach((input) => {
    const r = Number(input.dataset.row);
    const c = Number(input.dataset.col);
    const raw = input.value.trim();
    if (raw === '') return;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 90) grid[r][c] = n;
  });
  return grid;
}

export function buildReadonlyGrid(ticket, matchedSet = new Set()) {
  const el = document.createElement('div');
  el.className = 'ticket-grid readonly';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const val = ticket.grid[r][c];
      const cell = document.createElement('div');
      cell.className = 'ticket-cell'
        + (val == null ? ' empty' : '')
        + (val != null && matchedSet.has(val) ? ' matched' : '');
      cell.textContent = val == null ? '' : String(val);
      el.appendChild(cell);
    }
  }
  return el;
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let toastTimer = null;
export function showToast(message, duration = 2200) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

export function burstConfetti({ big = false } = {}) {
  const canvas = document.getElementById('confetti-canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const colors = ['#8b5cf6', '#facc15', '#34d399', '#fb7185', '#60a5fa'];
  const count = big ? 220 : 110;
  const particles = Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: -20 - Math.random() * h * 0.3,
    size: 4 + Math.random() * 5,
    vy: 2 + Math.random() * 3,
    vx: -2 + Math.random() * 4,
    rot: Math.random() * Math.PI,
    vrot: -0.2 + Math.random() * 0.4,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  let frame = 0;
  const maxFrames = big ? 150 : 100;

  function tick() {
    frame++;
    ctx.clearRect(0, 0, w, h);
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.rot += p.vrot;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });
    if (frame < maxFrames) {
      requestAnimationFrame(tick);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
  }
  requestAnimationFrame(tick);
}

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

export function playBeep(freq = 740, duration = 0.12) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
  } catch {
    // Audio is a nice-to-have; never let it break the game.
  }
}

export function playFanfare() {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((freq, i) => {
    setTimeout(() => playBeep(freq, 0.18), i * 120);
  });
}
