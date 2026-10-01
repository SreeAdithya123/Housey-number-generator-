// Core Housie/Tambola engine: ticket model, the 1-90 draw pool, prize
// pattern checks, and the "decoy draws then forced draws" rig mechanic.
//
// Rig mechanic, by design: the first `decoyCount` numbers of a game are
// always genuinely random. Only after that does an armed rig start feeding
// pre-selected numbers from the chosen ticket into the draw, in random
// order, until that ticket satisfies the prize condition. Every prize check
// runs against every ticket on every call, rigged or not, so if an
// unrigged ticket legitimately completes a prize first, it wins fairly.
// This tool has no concept of money or stakes; it is a party-trick helper
// for free games among friends, not a tool for rigging a paid draw.

export const PRIZE_ORDER = ['earlyFive', 'topLine', 'middleLine', 'bottomLine', 'fullHouse'];

export const PRIZE_LABELS = {
  earlyFive: 'Early Five',
  topLine: 'Top Line',
  middleLine: 'Middle Line',
  bottomLine: 'Bottom Line',
  fullHouse: 'Full House',
};

export function makeId(prefix = 't') {
  if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createTicket(id, name, grid) {
  const numbers = [];
  grid.forEach((row) => row.forEach((cell) => {
    if (cell != null) numbers.push(cell);
  }));
  return { id, name, grid, numbers };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Game {
  constructor() {
    this.tickets = [];
    this.pool = [];
    this.called = [];
    this.calledSet = new Set();
    this.decoyCount = 2;
    this.rigs = {};
    this.wins = {};
    this.forcedQueue = [];
    this.started = false;
    this.finished = false;
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event, payload) {
    this.listeners.forEach((fn) => fn(event, payload));
  }

  addTicket(ticket) {
    this.tickets.push(ticket);
    this.emit('tickets-changed');
  }

  removeTicket(id) {
    this.tickets = this.tickets.filter((t) => t.id !== id);
    Object.keys(this.rigs).forEach((prizeKey) => {
      if (this.rigs[prizeKey] === id) delete this.rigs[prizeKey];
    });
    this.emit('tickets-changed');
  }

  setDecoyCount(n) {
    if (this.called.length > 0) return;
    this.decoyCount = Math.max(0, Math.min(89, Math.floor(n) || 0));
    this.emit('settings-changed');
  }

  armRig(prizeKey, ticketId) {
    if (this.wins[prizeKey]) return false;
    this.rigs[prizeKey] = ticketId;
    this.emit('rigs-changed');
    return true;
  }

  unarmRig(prizeKey) {
    delete this.rigs[prizeKey];
    this.emit('rigs-changed');
  }

  start() {
    this.pool = Array.from({ length: 90 }, (_, i) => i + 1);
    this.called = [];
    this.calledSet = new Set();
    this.wins = {};
    this.forcedQueue = [];
    this.started = true;
    this.finished = false;
    this.emit('game-started');
  }

  reset() {
    this.started = false;
    this.finished = false;
    this.pool = [];
    this.called = [];
    this.calledSet = new Set();
    this.wins = {};
    this.forcedQueue = [];
    this.rigs = {};
    this.emit('game-reset');
  }

  ticketMatched(ticket) {
    return ticket.numbers.filter((n) => this.calledSet.has(n));
  }

  rowComplete(ticket, rowIdx) {
    const rowNums = ticket.grid[rowIdx].filter((n) => n != null);
    return rowNums.length > 0 && rowNums.every((n) => this.calledSet.has(n));
  }

  prizeSatisfied(prizeKey, ticket) {
    switch (prizeKey) {
      case 'earlyFive': return this.ticketMatched(ticket).length >= 5;
      case 'topLine': return this.rowComplete(ticket, 0);
      case 'middleLine': return this.rowComplete(ticket, 1);
      case 'bottomLine': return this.rowComplete(ticket, 2);
      case 'fullHouse': return ticket.numbers.length > 0 && this.ticketMatched(ticket).length === ticket.numbers.length;
      default: return false;
    }
  }

  evaluateWins() {
    const newWins = [];
    for (const prizeKey of PRIZE_ORDER) {
      if (this.wins[prizeKey]) continue;
      for (const ticket of this.tickets) {
        if (this.prizeSatisfied(prizeKey, ticket)) {
          this.wins[prizeKey] = { ticketId: ticket.id, atCall: this.called.length };
          newWins.push({ prizeKey, ticket });
          break;
        }
      }
    }
    return newWins;
  }

  removeFromPool(num) {
    const idx = this.pool.indexOf(num);
    if (idx !== -1) this.pool.splice(idx, 1);
  }

  refillForcedQueue() {
    this.forcedQueue = this.forcedQueue.filter((item) => !this.wins[item.prizeKey]);
    if (this.forcedQueue.length > 0) return;

    for (const prizeKey of PRIZE_ORDER) {
      if (this.wins[prizeKey]) continue;
      const ticketId = this.rigs[prizeKey];
      if (!ticketId) continue;
      const ticket = this.tickets.find((t) => t.id === ticketId);
      if (!ticket) continue;

      const uncalled = ticket.numbers.filter((n) => !this.calledSet.has(n));
      let needed;
      if (prizeKey === 'earlyFive') {
        const have = this.ticketMatched(ticket).length;
        const need = Math.max(0, 5 - have);
        needed = shuffle(uncalled.slice()).slice(0, need);
      } else if (prizeKey === 'fullHouse') {
        needed = shuffle(uncalled.slice());
      } else {
        const rowIdx = prizeKey === 'topLine' ? 0 : prizeKey === 'middleLine' ? 1 : 2;
        needed = shuffle(ticket.grid[rowIdx].filter((n) => n != null && !this.calledSet.has(n)));
      }

      if (needed.length > 0) {
        this.forcedQueue.push(...needed.map((number) => ({ number, prizeKey })));
        return;
      }
    }
  }

  canCallNext() {
    return this.started && !this.finished && this.pool.length > 0;
  }

  callNext() {
    if (!this.canCallNext()) return null;

    let num;
    let forcedPrizeKey = null;
    const inDecoyPhase = this.called.length < this.decoyCount;

    if (!inDecoyPhase) this.refillForcedQueue();

    if (!inDecoyPhase && this.forcedQueue.length > 0) {
      const next = this.forcedQueue.shift();
      num = next.number;
      forcedPrizeKey = next.prizeKey;
      this.removeFromPool(num);
    } else {
      const idx = Math.floor(Math.random() * this.pool.length);
      num = this.pool[idx];
      this.pool.splice(idx, 1);
    }

    this.called.push(num);
    this.calledSet.add(num);

    const newWins = this.evaluateWins();
    if (this.pool.length === 0) this.finished = true;

    const result = { number: num, forced: forcedPrizeKey, newWins, finished: this.finished };
    this.emit('number-called', result);
    return result;
  }

  undoLast() {
    if (this.called.length === 0) return;
    const num = this.called.pop();
    this.calledSet.delete(num);
    this.pool.push(num);
    this.wins = {};
    this.finished = false;
    this.evaluateWins();
    this.emit('undo', { number: num });
  }

  nextForcedPreview() {
    if (!this.started) return null;
    const inDecoyPhase = this.called.length < this.decoyCount;
    if (inDecoyPhase) return { decoysRemaining: this.decoyCount - this.called.length };

    this.refillForcedQueue();
    if (this.forcedQueue.length === 0) return null;
    const next = this.forcedQueue[0];
    const ticket = this.tickets.find((t) => t.id === this.rigs[next.prizeKey]);
    return { number: next.number, prizeKey: next.prizeKey, ticketName: ticket?.name };
  }

  allPrizesWon() {
    return PRIZE_ORDER.every((p) => this.wins[p]);
  }
}
