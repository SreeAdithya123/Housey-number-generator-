import { Game, createTicket, makeId, PRIZE_ORDER, PRIZE_LABELS } from './game.js';
import { scanTicketImage } from './ocr.js';
import {
  buildEditableGrid, readGridFromDom, buildReadonlyGrid, escapeHtml,
  showToast, burstConfetti, playBeep, playFanfare,
} from './ui.js';

const game = new Game();
let currentFile = null;
let currentScanGridEl = null;
let autoTimer = null;

const el = (id) => document.getElementById(id);

function emptyGrid3x9() {
  return Array.from({ length: 3 }, () => Array(9).fill(null));
}

function showScreen(name) {
  el('screen-setup').classList.toggle('hidden', name !== 'setup');
  el('screen-game').classList.toggle('hidden', name !== 'game');
  el('btn-new-game').classList.toggle('hidden', name !== 'game');
}

function setMode(mode) {
  document.body.classList.toggle('presentation', mode === 'presentation');
  el('tab-host').classList.toggle('active', mode === 'host');
  el('tab-presentation').classList.toggle('active', mode === 'presentation');
}

// ---------------- Setup screen: ticket upload + OCR ----------------

function setProgress(frac, label) {
  el('ocr-progress-bar').style.width = `${Math.round(frac * 100)}%`;
  el('ocr-progress-label').textContent = label;
}

function renderScanGrid(grid) {
  const container = el('scan-grid');
  container.innerHTML = '';
  currentScanGridEl = buildEditableGrid(grid);
  container.appendChild(currentScanGridEl);
}

async function runScan(file) {
  el('ocr-progress').classList.remove('hidden');
  el('scan-result').classList.add('hidden');
  setProgress(0, 'Starting...');
  try {
    const { grid } = await scanTicketImage(file, setProgress);
    renderScanGrid(grid);
  } catch (err) {
    showToast(err.message || 'Could not read that photo, fix the grid by hand below.', 3200);
    renderScanGrid(emptyGrid3x9());
  } finally {
    el('ocr-progress').classList.add('hidden');
    el('scan-result').classList.remove('hidden');
  }
}

el('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  currentFile = file;
  runScan(file);
});

el('btn-rescan').addEventListener('click', () => {
  if (currentFile) runScan(currentFile);
});

el('btn-save-ticket').addEventListener('click', () => {
  if (!currentScanGridEl) return;
  const grid = readGridFromDom(currentScanGridEl);
  const flatCount = grid.flat().filter((v) => v != null).length;
  if (flatCount === 0) {
    showToast('Add at least one number before saving.');
    return;
  }
  const name = el('ticket-name-input').value.trim() || `Player ${game.tickets.length + 1}`;
  const ticket = createTicket(makeId(), name, grid);
  game.addTicket(ticket);

  el('ticket-name-input').value = '';
  el('scan-result').classList.add('hidden');
  el('file-input').value = '';
  currentFile = null;
  currentScanGridEl = null;

  renderTicketList();
  el('btn-start-game').disabled = game.tickets.length === 0;
  showToast(`Saved ${name}'s ticket (${flatCount} numbers).`);
});

function renderTicketList() {
  const listCard = el('ticket-list-card');
  const list = el('ticket-list');
  list.innerHTML = '';
  if (game.tickets.length === 0) {
    listCard.classList.add('hidden');
    return;
  }
  listCard.classList.remove('hidden');
  game.tickets.forEach((ticket) => {
    const item = document.createElement('div');
    item.className = 'card';
    item.style.marginBottom = '0';

    const title = document.createElement('div');
    title.className = 'ticket-card-title';
    title.innerHTML = `<span>${escapeHtml(ticket.name)}</span><span class="count">${ticket.numbers.length} numbers</span>`;
    item.appendChild(title);
    item.appendChild(buildReadonlyGrid(ticket));

    const actions = document.createElement('div');
    actions.className = 'ticket-card-actions';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-sm btn-danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      game.removeTicket(ticket.id);
      renderTicketList();
      el('btn-start-game').disabled = game.tickets.length === 0;
    });
    actions.appendChild(removeBtn);
    item.appendChild(actions);

    list.appendChild(item);
  });
}

// ---------------- Starting the game ----------------

el('btn-start-game').addEventListener('click', () => {
  if (game.tickets.length === 0) return;
  game.start();
  renderBoard();
  setMode('host');
  showScreen('game');
  renderAll();
});

el('tab-host').addEventListener('click', () => setMode('host'));
el('tab-presentation').addEventListener('click', () => setMode('presentation'));

el('decoy-count').addEventListener('change', (e) => {
  game.setDecoyCount(parseInt(e.target.value, 10) || 0);
  renderForcedPreview();
});

// ---------------- Host rig panel ----------------

function renderRigRows() {
  const container = el('rig-rows');
  container.innerHTML = '';

  PRIZE_ORDER.forEach((prizeKey) => {
    const row = document.createElement('div');
    row.className = 'rig-row';

    const label = document.createElement('div');
    label.className = 'prize-label';
    label.textContent = PRIZE_LABELS[prizeKey];
    row.appendChild(label);

    const win = game.wins[prizeKey];
    if (win) {
      const ticket = game.tickets.find((t) => t.id === win.ticketId);
      const tag = document.createElement('span');
      tag.className = 'armed-tag';
      tag.textContent = `Won by ${ticket ? ticket.name : 'unknown'}`;
      row.appendChild(tag);
      container.appendChild(row);
      return;
    }

    const select = document.createElement('select');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Choose ticket...';
    select.appendChild(blank);
    game.tickets.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      if (game.rigs[prizeKey] === t.id) opt.selected = true;
      select.appendChild(opt);
    });
    row.appendChild(select);

    const armed = Boolean(game.rigs[prizeKey]);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-sm ${armed ? 'btn-danger' : 'btn-host'}`;
    btn.textContent = armed ? 'Unarm' : 'Arm';
    btn.addEventListener('click', () => {
      if (armed) {
        game.unarmRig(prizeKey);
      } else {
        const ticketId = select.value;
        if (!ticketId) {
          showToast('Pick a ticket first.');
          return;
        }
        game.armRig(prizeKey, ticketId);
      }
      renderRigRows();
      renderForcedPreview();
    });
    row.appendChild(btn);

    if (armed) {
      const tag = document.createElement('span');
      tag.className = 'armed-tag';
      const t = game.tickets.find((tt) => tt.id === game.rigs[prizeKey]);
      tag.textContent = `Armed: ${t ? t.name : '?'}`;
      row.appendChild(tag);
    }

    container.appendChild(row);
  });
}

function renderForcedPreview() {
  const box = el('forced-preview');
  const preview = game.nextForcedPreview();
  if (!preview) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  if (preview.decoysRemaining != null) {
    const n = preview.decoysRemaining;
    box.textContent = `${n} genuine random draw${n === 1 ? '' : 's'} left before any armed fix can kick in.`;
  } else {
    box.textContent = `Next forced number: ${preview.number} (for ${PRIZE_LABELS[preview.prizeKey]} -> ${preview.ticketName || 'unknown'})`;
  }
}

// ---------------- Board ----------------

function renderBoard() {
  const board = el('board');
  board.innerHTML = '';
  for (let n = 1; n <= 90; n++) {
    const cell = document.createElement('div');
    cell.className = 'num';
    cell.textContent = String(n);
    cell.dataset.n = String(n);
    board.appendChild(cell);
  }
}

function updateBoard() {
  const current = game.called[game.called.length - 1];
  el('board').querySelectorAll('.num').forEach((cell) => {
    const n = Number(cell.dataset.n);
    cell.classList.toggle('called', game.calledSet.has(n));
    cell.classList.toggle('current', n === current);
  });
}

// ---------------- Prize tracker ----------------

function renderPrizeTracker() {
  const container = el('prize-tracker');
  container.innerHTML = '';
  PRIZE_ORDER.forEach((prizeKey) => {
    const badge = document.createElement('div');
    const win = game.wins[prizeKey];
    badge.className = `prize-badge${win ? ' won' : ''}`;

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = PRIZE_LABELS[prizeKey];
    badge.appendChild(name);

    const winner = document.createElement('div');
    if (win) {
      const ticket = game.tickets.find((t) => t.id === win.ticketId);
      winner.className = 'winner';
      winner.textContent = `\u{1F3C6} ${ticket ? ticket.name : 'Unknown'}`;
    } else {
      winner.className = 'winner pending';
      winner.textContent = 'Not yet';
    }
    badge.appendChild(winner);
    container.appendChild(badge);
  });
}

// ---------------- Live ticket cards ----------------

function renderGameTickets() {
  const container = el('game-tickets');
  container.innerHTML = '';
  game.tickets.forEach((ticket) => {
    const card = document.createElement('div');
    card.className = 'card game-ticket-card';
    card.style.marginBottom = '0';

    const title = document.createElement('div');
    title.className = 'ticket-card-title';
    title.innerHTML = `<span>${escapeHtml(ticket.name)}</span>`;
    card.appendChild(title);

    const matched = new Set(game.ticketMatched(ticket));
    card.appendChild(buildReadonlyGrid(ticket, matched));

    const progress = document.createElement('div');
    progress.className = 'progress';
    const wonPrizes = PRIZE_ORDER
      .filter((p) => game.wins[p]?.ticketId === ticket.id)
      .map((p) => PRIZE_LABELS[p]);
    progress.textContent = `${matched.size}/${ticket.numbers.length} matched`
      + (wonPrizes.length ? ` - ${wonPrizes.join(', ')}` : '');
    card.appendChild(progress);

    container.appendChild(card);
  });
}

// ---------------- Caller ----------------

function renderCaller() {
  const ball = el('caller-ball');
  const current = game.called[game.called.length - 1];
  ball.textContent = current ?? '–';
  el('called-count').textContent = String(game.called.length);

  const history = el('caller-history');
  history.innerHTML = '';
  game.called.slice().reverse().slice(0, 14).forEach((n) => {
    const span = document.createElement('span');
    span.textContent = String(n);
    history.appendChild(span);
  });
}

function popBall() {
  const ball = el('caller-ball');
  ball.classList.remove('pop');
  void ball.offsetWidth;
  ball.classList.add('pop');
}

// ---------------- Call controls ----------------

function doCallNext() {
  const result = game.callNext();
  if (!result) {
    stopAutoCall();
    showToast(game.finished ? 'All 90 numbers have been called.' : 'Start the game first.');
    return;
  }

  playBeep();
  renderAll();
  popBall();

  result.newWins.forEach(({ prizeKey, ticket }) => {
    playFanfare();
    burstConfetti({ big: prizeKey === 'fullHouse' });
    showToast(`${PRIZE_LABELS[prizeKey]}: ${ticket.name} wins!`, 3000);
  });

  if (result.finished) {
    stopAutoCall();
    showToast('Board complete: all 90 numbers called.', 3000);
  }
}

el('btn-call-next').addEventListener('click', doCallNext);

el('btn-undo').addEventListener('click', () => {
  stopAutoCall();
  game.undoLast();
  renderAll();
});

el('chk-auto-call').addEventListener('change', (e) => {
  if (e.target.checked) startAutoCall(); else stopAutoCall();
});

el('auto-call-rate').addEventListener('change', () => {
  if (el('chk-auto-call').checked) {
    stopAutoCall(true);
    startAutoCall();
  }
});

function startAutoCall() {
  stopAutoCall(true);
  const rate = parseInt(el('auto-call-rate').value, 10);
  autoTimer = setInterval(() => {
    if (!game.canCallNext()) {
      stopAutoCall();
      return;
    }
    doCallNext();
  }, rate);
}

function stopAutoCall(keepChecked = false) {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  if (!keepChecked) el('chk-auto-call').checked = false;
}

// ---------------- New game ----------------

el('btn-new-game').addEventListener('click', () => {
  if (!window.confirm('Start a brand new game? This clears all tickets and the current draw.')) return;
  stopAutoCall();
  game.reset();
  game.tickets = [];
  renderTicketList();
  el('btn-start-game').disabled = true;
  el('ticket-name-input').value = '';
  el('scan-result').classList.add('hidden');
  setMode('host');
  showScreen('setup');
});

// ---------------- Render orchestration ----------------

function renderAll() {
  renderCaller();
  updateBoard();
  renderPrizeTracker();
  renderGameTickets();
  renderRigRows();
  renderForcedPreview();
  el('btn-call-next').disabled = !game.canCallNext();
}

// ---------------- PWA install prompt ----------------

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  el('btn-install').classList.remove('hidden');
});

el('btn-install').addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    el('btn-install').classList.add('hidden');
  } else if (isIos()) {
    showToast('On iPhone: tap the Share icon, then "Add to Home Screen".', 4000);
  }
});

if (isIos() && !isStandalone()) {
  el('btn-install').classList.remove('hidden');
  el('btn-install').textContent = 'Add to Home Screen';
}

window.addEventListener('appinstalled', () => {
  el('btn-install').classList.add('hidden');
});

// ---------------- Service worker ----------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ---------------- Init ----------------

showScreen('setup');
renderTicketList();
