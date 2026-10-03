// Rules of a standard 90-ball Housie/Tambola ticket, used to turn a model's
// reading of a ticket into a grid and to flag anything that looks misread:
// 3 rows x 9 columns, 5 numbers per row, column 1 holds 1-9, column 2 holds
// 10-19 ... column 9 holds 80-90, and numbers ascend down each column.

export const ROWS = 3;
export const COLS = 9;
export const NUMBERS_PER_ROW = 5;

export function columnForNumber(n) {
  return n >= 80 ? COLS - 1 : Math.floor(n / 10);
}

function emptyGrid() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function addFlag(flags, row, col, reason) {
  const existing = flags.find((f) => f.row === row && f.col === col);
  if (existing) {
    if (!existing.reason.includes(reason)) existing.reason += `; ${reason}`;
  } else {
    flags.push({ row, col, reason });
  }
}

function nearestEmptyColumn(rowCells, target) {
  for (let d = 1; d < COLS; d++) {
    if (target - d >= 0 && rowCells[target - d] == null) return target - d;
    if (target + d < COLS && rowCells[target + d] == null) return target + d;
  }
  return -1;
}

/**
 * Places each row's numbers into the column their value belongs to, so the
 * layout never depends on a model aligning blank cells correctly. If two
 * numbers in one row claim the same column, one of them was misread: it is
 * moved to the nearest free cell and both cells are flagged.
 */
export function gridFromRows(rows) {
  const grid = emptyGrid();
  const flags = [];

  rows.slice(0, ROWS).forEach((numbers, r) => {
    [...numbers].sort((a, b) => a - b).forEach((n) => {
      const col = columnForNumber(n);
      if (grid[r][col] == null) {
        grid[r][col] = n;
        return;
      }
      const free = nearestEmptyColumn(grid[r], col);
      if (free === -1) return;
      grid[r][free] = n;
      const reason = `two numbers in this row belong in column ${col + 1}`;
      addFlag(flags, r, col, reason);
      addFlag(flags, r, free, reason);
    });
  });

  return { grid, flags };
}

/**
 * Checks a grid against the ticket rules. Returns the suspicious cells
 * (merged with any already-known `extraFlags`) and row-level notes.
 */
export function checkTicket(grid, extraFlags = []) {
  const flags = extraFlags.map((f) => ({ ...f }));
  const notes = [];
  const seen = new Map();

  for (let r = 0; r < ROWS; r++) {
    let count = 0;
    for (let c = 0; c < COLS; c++) {
      const n = grid[r][c];
      if (n == null) continue;
      count++;

      if (columnForNumber(n) !== c) {
        addFlag(flags, r, c, `${n} normally sits in column ${columnForNumber(n) + 1}`);
      }

      if (seen.has(n)) {
        const first = seen.get(n);
        addFlag(flags, first.row, first.col, `${n} appears twice`);
        addFlag(flags, r, c, `${n} appears twice`);
      } else {
        seen.set(n, { row: r, col: c });
      }
    }
    if (count !== NUMBERS_PER_ROW) {
      notes.push(`Row ${r + 1} has ${count} number${count === 1 ? '' : 's'} but a ticket row has ${NUMBERS_PER_ROW}.`);
    }
  }

  for (let c = 0; c < COLS; c++) {
    let previous = null;
    for (let r = 0; r < ROWS; r++) {
      const n = grid[r][c];
      if (n == null) continue;
      if (previous != null && n <= previous) {
        addFlag(flags, r, c, `${n} should be larger than the number above it`);
      }
      previous = n;
    }
  }

  return { flags, notes };
}
