import { Game, createTicket, makeId, PRIZE_ORDER, PRIZE_LABELS } from './game.js';
import { scanTicketImage, checkAiScanner } from './ocr.js';
import * as backend from './backend.js';
import {
  buildEditableGrid, readGridFromDom, buildReadonlyGrid, escapeHtml,
  showToast, burstConfetti, playBeep, playFanfare,
} from './ui.js';

const game = new Game();
let currentFile = null;
let currentScanGridEl = null;

// 'admin' runs the game and sees everything: tickets, prizes, board, host
// controls. 'player' (a signed-in non-admin or a guest) only generates
// numbers for the shared draw and sees the caller ball and history, nothing else.
let role = 'player';

// What the caller (both roles), board and prize tracker (admin only) draw:
// the admin's own game turned into this shape, a player's copy of the public
// database row.
let view = { status: 'setup', called: [], wins: {}, updatedAt: null };

const el = (id) => document.getElementById(id);

function emptyGrid3x9() {
  return Array.from({ length: 3 }, () => Array(9).fill(null));
}

function showScreen(name) {
  el('screen-setup').classList.toggle('hidden', name !== 'setup');
  el('screen-game').classList.toggle('hidden', name !== 'game');
  el('btn-new-game').classList.toggle('hidden', name !== 'game' || role !== 'admin');
}

function setMode(mode) {
  document.body.classList.toggle('presentation', mode === 'presentation');
  el('tab-host').classList.toggle('active', mode === 'host');
  el('tab-presentation').classList.toggle('active', mode === 'presentation');
}

// ---------------- Setup screen: ticket upload + scan ----------------

function setProgress(frac, label) {
  el('ocr-progress-bar').style.width = `${Math.round(frac * 100)}%`;
  el('ocr-progress-label').textContent = label;
}

function renderScanGrid(grid, flags = []) {
  const container = el('scan-grid');
  container.innerHTML = '';
  currentScanGridEl = buildEditableGrid(grid, flags);
  container.appendChild(currentScanGridEl);
}

function showScanNote(text, tone) {
  const note = el('scan-note');
  note.textContent = text;
  note.className = `scan-note ${tone}`;
}

const AI_STATUS = {
  ready: ['ok', 'AI scanner is ready.'],
  no_key: ['warn', 'AI scanner is deployed but has no API key. Add the OPENROUTER_API_KEY secret in Cloudflare, then redeploy.'],
  not_deployed: ['warn', "AI scanner isn't available on this host (no /api/scan), so ticket numbers have to be typed in."],
  offline: ['warn', "Couldn't reach the AI scanner. Check your connection."],
};

async function showAiStatus() {
  const [tone, text] = AI_STATUS[await checkAiScanner()];
  const status = el('ai-status');
  status.textContent = text;
  status.className = `scan-note ${tone}`;
  status.style.marginTop = '12px';
}

function describeScan({ source, model, fallbackReason, flags, notes }) {
  if (source !== 'ai') {
    showScanNote(`${fallbackReason} Type the numbers from your ticket below, or tap Re-scan photo to try again.`, 'warn');
    return;
  }

  const parts = [];
  const label = model ? model.split('/').pop().replace(':free', '') : 'AI model';
  parts.push(`Read by AI (${label}).`);
  if (flags.length) {
    parts.push(flags.length === 1 ? '1 highlighted box looks wrong.' : `${flags.length} highlighted boxes look wrong.`);
  }
  parts.push(...notes);
  parts.push('Check every number against your ticket before saving.');

  const clean = flags.length === 0 && notes.length === 0;
  showScanNote(parts.join(' '), clean ? 'ok' : 'warn');
}

async function runScan(file) {
  el('ocr-progress').classList.remove('hidden');
  el('scan-result').classList.add('hidden');
  setProgress(0, 'Starting...');
  try {
    const result = await scanTicketImage(file, setProgress);
    renderScanGrid(result.grid, result.flags);
    describeScan(result);
  } catch (err) {
    showToast(err.message || 'Could not read that photo.', 3200);
    renderScanGrid(emptyGrid3x9());
    showScanNote("Couldn't scan this photo automatically. Type the numbers in from your ticket.", 'warn');
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
  syncAdmin();
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
      syncAdmin();
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
  syncAdmin();
  syncPublic();
});

el('tab-host').addEventListener('click', () => setMode('host'));
el('tab-presentation').addEventListener('click', () => setMode('presentation'));

el('decoy-count').addEventListener('change', (e) => {
  game.setDecoyCount(parseInt(e.target.value, 10) || 0);
  renderForcedPreview();
  syncAdmin();
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
      syncAdmin();
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
  // Not in a player's DOM: only the admin ever sees the board.
  const board = el('board');
  if (!board) return;
  const current = view.called[view.called.length - 1];
  const called = new Set(view.called);
  board.querySelectorAll('.num').forEach((cell) => {
    const n = Number(cell.dataset.n);
    cell.classList.toggle('called', called.has(n));
    cell.classList.toggle('current', n === current);
  });
}

// ---------------- Prize tracker ----------------

function renderPrizeTracker() {
  // Not in a player's DOM: only the admin ever sees the prize tracker.
  const container = el('prize-tracker');
  if (!container) return;
  container.innerHTML = '';
  PRIZE_ORDER.forEach((prizeKey) => {
    const badge = document.createElement('div');
    const win = view.wins[prizeKey];
    badge.className = `prize-badge${win ? ' won' : ''}`;

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = PRIZE_LABELS[prizeKey];
    badge.appendChild(name);

    const winner = document.createElement('div');
    if (win) {
      winner.className = 'winner';
      winner.textContent = `\u{1F3C6} ${win.name || 'Unknown'}`;
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
  const current = view.called[view.called.length - 1];
  ball.textContent = current ?? '–';
  el('called-count').textContent = String(view.called.length);

  const history = el('caller-history');
  history.innerHTML = '';
  view.called.slice().reverse().slice(0, 14).forEach((n) => {
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

// Drawing numbers forward is a player action (backend.callNextNumber, a
// database RPC with its own access to rigs/tickets); the admin only corrects
// with Undo, which still runs locally since it needs the admin's own tickets.
el('btn-undo').addEventListener('click', () => {
  game.undoLast();
  renderAll();
  syncPublic();
});

el('btn-generate-next').addEventListener('click', async () => {
  const btn = el('btn-generate-next');
  btn.disabled = true;
  try {
    const result = await backend.callNextNumber();
    if (result?.reason === 'not_running') showToast('Waiting for the host to start the game.');
    else if (result?.reason === 'finished') showToast('All 90 numbers have been called.');
  } catch (err) {
    showToast(err.message || 'Could not generate a number. Check your connection.');
  } finally {
    btn.disabled = false;
  }
});

// ---------------- New game ----------------

el('btn-new-game').addEventListener('click', () => {
  if (!window.confirm('Start a brand new game? This clears all tickets and the current draw.')) return;
  game.reset();
  game.tickets = [];
  renderTicketList();
  el('btn-start-game').disabled = true;
  el('ticket-name-input').value = '';
  el('scan-result').classList.add('hidden');
  setMode('host');
  showScreen('setup');
  syncAdmin();
  syncPublic();
});

// ---------------- Render orchestration ----------------

function viewFromGame() {
  const wins = {};
  PRIZE_ORDER.forEach((prizeKey) => {
    const win = game.wins[prizeKey];
    if (!win) return;
    const ticket = game.tickets.find((t) => t.id === win.ticketId);
    wins[prizeKey] = { name: ticket ? ticket.name : 'Unknown', atCall: win.atCall };
  });
  const status = game.finished ? 'finished' : game.started ? 'running' : 'setup';
  return { status, called: [...game.called], wins, updatedAt: null };
}

// Players wait on a plain message until the host starts the game.
function renderWaiting() {
  const waiting = role === 'player' && view.status === 'setup';
  el('waiting-card').classList.toggle('hidden', !waiting);
  document.querySelectorAll('#screen-game .live-card').forEach((card) => card.classList.toggle('hidden', waiting));
}

function renderPublic() {
  renderCaller();
  updateBoard();
  renderPrizeTracker();
  renderWaiting();
}

function renderAll() {
  view = viewFromGame();
  renderPublic();
  renderGameTickets();
  renderRigRows();
  renderForcedPreview();
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

// ---------------- Sharing the game with the backend ----------------

const syncOk = { admin: true, public: true };

function renderSyncStatus() {
  const badge = el('sync-status');
  const healthy = role === 'admin' ? syncOk.admin && syncOk.public : syncOk.public;
  badge.classList.remove('hidden', 'ok', 'warn');
  badge.classList.add(healthy ? 'ok' : 'warn');
  if (role === 'admin') badge.textContent = healthy ? 'Players in sync' : 'Players not in sync, retrying';
  else badge.textContent = healthy ? 'Live' : 'Reconnecting...';
}

// Sends the latest state to the backend. Calls made while a send is running
// collapse into one more send of the newest state, and a failed send retries
// on its own, so a flaky connection never blocks the game.
function createSyncer(name, buildPayload, send) {
  let running = false;
  let again = false;
  let retry = null;

  const run = async () => {
    clearTimeout(retry);
    if (role !== 'admin') return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await send(buildPayload());
      } while (again);
      syncOk[name] = true;
    } catch {
      syncOk[name] = false;
      retry = setTimeout(run, 5000);
    } finally {
      running = false;
      renderSyncStatus();
    }
  };
  return run;
}

function publicPayload() {
  const current = viewFromGame();
  const last = current.called[current.called.length - 1];
  return { status: current.status, called: current.called, current_number: last ?? null, wins: current.wins };
}

const syncPublic = createSyncer('public', publicPayload, backend.publishPublic);
const syncAdmin = createSyncer('admin', () => ({
  tickets: game.tickets,
  rigs: game.rigs,
  decoy_count: game.decoyCount,
}), backend.saveAdmin);

// ---------------- Sign in ----------------

let signedIn = false;

function setAuthMessage(text) {
  const box = el('auth-message');
  box.textContent = text || '';
  box.classList.toggle('hidden', !text);
}

function setAuthBusy(busy) {
  ['auth-submit', 'auth-signup', 'auth-cancel'].forEach((id) => { el(id).disabled = busy; });
}

function openAuth() {
  setAuthMessage('');
  el('auth-overlay').classList.remove('hidden');
  el('auth-email').focus();
}

function closeAuth() {
  el('auth-overlay').classList.add('hidden');
}

async function submitAuth(action) {
  setAuthBusy(true);
  setAuthMessage('');
  try {
    const message = await action(el('auth-email').value.trim(), el('auth-password').value);
    if (message) {
      setAuthMessage(message);
      setAuthBusy(false);
      return;
    }
    window.location.reload();
  } catch (err) {
    setAuthMessage(err.message);
    setAuthBusy(false);
  }
}

el('btn-auth').addEventListener('click', async () => {
  if (!signedIn) {
    openAuth();
    return;
  }
  try {
    await backend.signOut();
  } catch {
    // signing out locally below is enough if the server can't be reached
  }
  window.location.reload();
});

el('auth-cancel').addEventListener('click', closeAuth);
el('auth-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth((email, password) => backend.signIn(email, password).then(() => null));
});
el('auth-signup').addEventListener('click', () => {
  if (!el('auth-form').reportValidity()) return;
  if (el('auth-password').value.length < 6) {
    setAuthMessage('Use a password with at least 6 characters.');
    return;
  }
  submitAuth(async (email, password) => {
    const { needsConfirmation } = await backend.signUp(email, password);
    return needsConfirmation ? 'Account created. Check your email to confirm it, then sign in.' : null;
  });
});

// ---------------- Starting up as admin or player ----------------

const ROLE_CACHE = 'housey.role.';

function wasAdmin(userId) {
  try {
    return localStorage.getItem(ROLE_CACHE + userId) === 'admin';
  } catch {
    return false;
  }
}

function rememberRole(userId, value) {
  try {
    localStorage.setItem(ROLE_CACHE + userId, value);
  } catch {
    // storage unavailable: the role is simply looked up again next time
  }
}

async function startAdmin() {
  document.body.classList.remove('role-player');

  let saved = null;
  let published = null;
  try {
    [published, saved] = await Promise.all([backend.loadPublic(), backend.loadAdmin()]);
  } catch {
    syncOk.admin = false;
    syncOk.public = false;
    showToast("Couldn't load the saved game. You can keep going; it syncs when the connection is back.", 4500);
  }

  if (saved) {
    game.restore({
      tickets: saved.tickets || [],
      rigs: saved.rigs || {},
      decoyCount: saved.decoy_count ?? 2,
      called: published?.called || [],
      started: Boolean(published) && published.status !== 'setup',
    });
  }

  el('decoy-count').value = String(game.decoyCount);
  renderTicketList();
  el('btn-start-game').disabled = game.tickets.length === 0;
  renderSyncStatus();
  showAiStatus();

  if (game.started) {
    renderBoard();
    setMode('host');
    showScreen('game');
    renderAll();
  } else {
    showScreen('setup');
  }

  // Players (anyone with the link) draw the numbers now, so the admin needs
  // its own live feed too: replay each incoming called list through the same
  // local engine Undo already uses, keeping board/prizes/forced-preview and
  // rig "won by" tags in sync with whoever is actually calling.
  try {
    backend.watchPublic(applyAdminPublicRow, (healthy) => {
      syncOk.public = healthy;
      renderSyncStatus();
    });
  } catch {
    syncOk.public = false;
  }
}

function applyAdminPublicRow(row) {
  if (!row || row.status === 'setup' || !game.started) return;

  const previousCalledCount = game.called.length;
  const previousWins = { ...game.wins };

  game.restore({
    tickets: game.tickets,
    rigs: game.rigs,
    decoyCount: game.decoyCount,
    called: row.called || [],
    started: true,
  });

  renderAll();

  if (game.called.length > previousCalledCount) {
    playBeep();
    popBall();
  }
  Object.keys(game.wins).filter((key) => !previousWins[key]).forEach((prizeKey) => {
    const ticket = game.tickets.find((t) => t.id === game.wins[prizeKey].ticketId);
    playFanfare();
    burstConfetti({ big: prizeKey === 'fullHouse' });
    showToast(`${PRIZE_LABELS[prizeKey]}: ${ticket ? ticket.name : 'Unknown'} wins!`, 3000);
  });
}

let playerLoaded = false;

function applyPublicRow(row) {
  const next = { status: row.status, called: row.called || [], wins: row.wins || {}, updatedAt: row.updated_at || null };
  if (view.updatedAt && next.updatedAt && Date.parse(next.updatedAt) < Date.parse(view.updatedAt)) return;

  const previous = view;
  view = next;
  renderPublic();

  if (playerLoaded) {
    if (next.called.length > previous.called.length) {
      playBeep();
      popBall();
    }
    Object.keys(next.wins).filter((key) => !previous.wins[key]).forEach((key) => {
      playFanfare();
      burstConfetti({ big: key === 'fullHouse' });
      showToast(`${PRIZE_LABELS[key]}: ${next.wins[key].name} wins!`, 3000);
    });
  }
  playerLoaded = true;
}

function startPlayer() {
  document.body.classList.add('presentation', 'role-player');
  showScreen('game');
  // A player's page gets no admin controls, board, prizes or tickets at all,
  // not just hidden ones: generating numbers is all a player can do.
  document.querySelectorAll('.host-only, .admin-only, .mode-tabs, #screen-setup, #btn-new-game').forEach((node) => node.remove());
  renderPublic();
  try {
    backend.watchPublic(applyPublicRow, (healthy) => {
      syncOk.public = healthy;
      renderSyncStatus();
    });
  } catch {
    syncOk.public = false;
  }
  renderSyncStatus();
}

async function init() {
  let session = null;
  try {
    session = await backend.getSession();
  } catch {
    // the live service is unreachable: carry on as a guest
  }

  signedIn = Boolean(session);
  el('btn-auth').textContent = signedIn ? 'Sign out' : 'Admin sign in';

  if (session) {
    try {
      role = await backend.fetchRole(session.user.id);
      rememberRole(session.user.id, role);
    } catch {
      role = wasAdmin(session.user.id) ? 'admin' : 'player';
    }
  }

  if (role === 'admin') await startAdmin();
  else startPlayer();
}

init();
