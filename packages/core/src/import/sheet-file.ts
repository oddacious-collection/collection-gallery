/**
 * Reading an edited spreadsheet file in the browser (IMP-06, D-71): CSV or
 * JSON in, rows for `/api/items/sheet` out. Problems that need the whole file
 * to see (the same item twice, unknown columns) are found here, before
 * anything is sent.
 */
import { readCsv } from './csv.ts';
import { LIST_COLUMNS, SHEET_BATCH, SHEET_COLUMNS, type SheetColumn } from './sheet-columns.ts';

export interface SheetFileRow {
  /** The row number as a spreadsheet shows it (the header is row 1), or the record number in JSON. */
  line: number;
  cells: Partial<Record<SheetColumn, string | string[]>>;
}

export interface SheetFile {
  columns: SheetColumn[];
  rows: SheetFileRow[];
  /** Columns in the file this app doesn't know (ignored). */
  unknownColumns: string[];
  /** Whole-file problems: nothing should be sent while there are any. */
  errors: string[];
}

const KNOWN = new Set<string>(SHEET_COLUMNS);
const normHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, '_');

function checkFile(file: SheetFile): SheetFile {
  if (!file.columns.some((c) => c === 'id' || c === 'slug' || c === 'title')) {
    file.errors.push('The file needs an id, slug or title column.');
  }
  const seen = new Map<string, number>();
  for (const row of file.rows) {
    const id = String(row.cells.id ?? '').trim();
    const slug = String(row.cells.slug ?? '').trim();
    const key = id ? `id:${id}` : slug ? `slug:${slug}` : '';
    if (!key) continue;
    const first = seen.get(key);
    if (first !== undefined) {
      file.errors.push(
        `Rows ${first} and ${row.line} are the same item (${id ? 'id' : 'slug'} ${id || slug}). Keep one of them.`,
      );
    } else {
      seen.set(key, row.line);
    }
  }
  return file;
}

/** A CSV export (possibly edited), first row the column names. */
export function readSheetCsv(text: string): SheetFile {
  const table = readCsv(text);
  const [header, ...body] = table;
  const file: SheetFile = { columns: [], rows: [], unknownColumns: [], errors: [] };
  if (!header) {
    file.errors.push('The file is empty.');
    return file;
  }
  const names = header.map(normHeader);
  const dupes = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (dupes.length)
    file.errors.push(`These columns appear twice: ${[...new Set(dupes)].join(', ')}.`);
  for (const n of names) {
    if (KNOWN.has(n)) file.columns.push(n as SheetColumn);
    else if (n) file.unknownColumns.push(n);
  }
  body.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    const row: SheetFileRow = { line: i + 2, cells: {} };
    names.forEach((n, j) => {
      if (KNOWN.has(n)) row.cells[n as SheetColumn] = cells[j] ?? '';
    });
    file.rows.push(row);
  });
  return checkFile(file);
}

function jsonCell(column: SheetColumn, v: unknown): string | string[] | undefined {
  if (v === null || v === undefined) return LIST_COLUMNS.includes(column) ? [] : '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  return undefined;
}

/** A JSON export (`{items: [...]}`) or a plain array of records. */
export function readSheetJson(text: string): SheetFile {
  const file: SheetFile = { columns: [], rows: [], unknownColumns: [], errors: [] };
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    file.errors.push('The file is not valid JSON.');
    return file;
  }
  const records = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? (data as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(records)) {
    file.errors.push('The file should be a JSON export (with an "items" list).');
    return file;
  }
  const columns = new Set<SheetColumn>();
  const unknown = new Set<string>();
  records.forEach((rec, i) => {
    const line = i + 1;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      file.errors.push(`Record ${line} is not an object.`);
      return;
    }
    const row: SheetFileRow = { line, cells: {} };
    for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
      if (!KNOWN.has(k)) {
        unknown.add(k);
        continue;
      }
      const col = k as SheetColumn;
      const cell = jsonCell(col, v);
      if (cell === undefined)
        file.errors.push(
          `Record ${line}: "${k}" should be text${LIST_COLUMNS.includes(col) ? ' or a list of text' : ''}.`,
        );
      else {
        row.cells[col] = cell;
        columns.add(col);
      }
    }
    file.rows.push(row);
  });
  // A field left out of one record is left as it is for that item (only the
  // cells a row carries are applied); an empty string or [] clears it.
  file.columns = SHEET_COLUMNS.filter((c) => columns.has(c));
  file.unknownColumns = [...unknown];
  return checkFile(file);
}

export function readSheetFile(name: string, text: string): SheetFile {
  return /\.json$/i.test(name) || /^\s*[[{]/.test(text) ? readSheetJson(text) : readSheetCsv(text);
}

/** Rows split into requests: at most `maxRows` rows and about `maxBytes` of JSON each. */
export function sheetBatches(
  rows: readonly SheetFileRow[],
  maxBytes = 900 * 1024,
  maxRows = SHEET_BATCH,
): SheetFileRow[][] {
  const batches: SheetFileRow[][] = [];
  let cur: SheetFileRow[] = [];
  let size = 0;
  for (const row of rows) {
    const bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
    if (cur.length && (cur.length >= maxRows || size + bytes > maxBytes)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(row);
    size += bytes;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
