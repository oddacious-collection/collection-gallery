/**
 * CSV for the spreadsheet export and import (IMP-06, D-71). RFC 4180: cells
 * with commas, quotes or line breaks are quoted, quotes doubled; CRLF line
 * ends; a UTF-8 byte-order mark so Excel reads accents correctly.
 *
 * Formula safety (OWASP CSV injection): a cell that starts with `=`, `+`, `-`,
 * `@`, a tab or a carriage return gets a leading `'` on export, so no
 * spreadsheet runs it; import removes that `'` again, so the round trip keeps
 * the text exactly.
 *
 * The reader is a single linear pass (no backtracking regexes).
 */

const FORMULA_START = new Set(['=', '+', '-', '@', '\t', '\r']);

/** How many `'` the text starts with, and whether a formula character follows them. */
function leadingQuotes(value: string): { quotes: number; formula: boolean } {
  let quotes = 0;
  while (value[quotes] === "'") quotes++;
  return { quotes, formula: FORMULA_START.has(value[quotes] ?? '') };
}

/**
 * A cell made safe to open in a spreadsheet: one `'` is added when the text
 * starts with a formula character, possibly after some `'` already (so text
 * that only looks protected also comes back exactly as it was).
 */
export function protectCell(value: string): string {
  return leadingQuotes(value).formula ? `'${value}` : value;
}

/** Undoes `protectCell`. */
export function unprotectCell(value: string): string {
  const { quotes, formula } = leadingQuotes(value);
  return formula && quotes > 0 ? value.slice(1) : value;
}

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** Rows to CSV text (with a byte-order mark), every cell formula-protected. */
export function writeCsv(rows: string[][]): string {
  return `\uFEFF${rows.map((r) => r.map((c) => quote(protectCell(c))).join(',')).join('\r\n')}\r\n`;
}

export class CsvError extends Error {
  override readonly name = 'CsvError';
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.line = line;
  }
}

/**
 * CSV text to rows of cells (formula protection removed). Blank lines are
 * skipped. Throws `CsvError` for an unterminated quote.
 */
export function readCsv(text: string): string[][] {
  const s = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let quoteLine = 1;
  const endCell = () => {
    row.push(unprotectCell(cell));
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? '';
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      quoteLine = line;
    } else if (ch === ',') {
      endCell();
    } else if (ch === '\r') {
      if (s[i + 1] === '\n') i++;
      endRow();
      line++;
    } else if (ch === '\n') {
      endRow();
      line++;
    } else {
      cell += ch;
    }
  }
  if (quoted) throw new CsvError('A quoted cell never ends', quoteLine);
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}
