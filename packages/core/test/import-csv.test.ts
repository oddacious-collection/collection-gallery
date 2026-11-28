/**
 * CSV and the spreadsheet file reader (IMP-06, D-71): RFC 4180 round trips,
 * formula protection (CSV injection), and turning an edited file into rows.
 */
import { describe, expect, it } from 'vitest';
import {
  CsvError,
  SHEET_BATCH,
  protectCell,
  readCsv,
  readSheetCsv,
  readSheetFile,
  readSheetJson,
  sheetBatches,
  unprotectCell,
  writeCsv,
} from '../src/import/index.ts';

describe('CSV', () => {
  it('round-trips commas, quotes, line breaks, accents and empty cells', () => {
    const rows = [
      ['id', 'title', 'description'],
      ['1', 'Pallasite, Esquel', 'He said "wow"\nand then\r\nleft'],
      ['2', '', 'Ça va — 隕石 🪨'],
      ['3', ' spaced ', ''],
    ];
    const text = writeCsv(rows);
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain('"Pallasite, Esquel"');
    expect(text).toContain('"He said ""wow""');
    expect(readCsv(text)).toEqual(rows);
  });

  it('protects cells a spreadsheet would run as formulas, and restores them on read', () => {
    for (const bad of ['=SUM(A1:A2)', '+1', '-2', '@cmd', '\tx', '\rx']) {
      expect(protectCell(bad)).toBe(`'${bad}`);
      expect(unprotectCell(protectCell(bad))).toBe(bad);
    }
    expect(protectCell('plain')).toBe('plain');
    expect(protectCell('')).toBe('');
    // A leading quote that isn't protection is kept as written.
    expect(unprotectCell("'hello")).toBe("'hello");
    expect(protectCell("'hello")).toBe("'hello");
    // Text that already looks protected survives the round trip too.
    for (const odd of ["'=1", "'-2", "''=3"]) {
      expect(unprotectCell(protectCell(odd))).toBe(odd);
      expect(readCsv(writeCsv([[odd]]))).toEqual([[odd]]);
    }
    const text = writeCsv([['=HYPERLINK("http://x","y")', '-5']]);
    expect(text).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(text).toContain(`,'-5`);
    expect(readCsv(text)).toEqual([['=HYPERLINK("http://x","y")', '-5']]);
  });

  it('reads LF or CRLF files with or without a byte-order mark, skipping blank lines', () => {
    expect(readCsv('a,b\n1,2\n\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(readCsv('﻿a,b\r\n1,\r\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  it('reports an unterminated quote with its line', () => {
    expect(() => readCsv('a,b\n1,"never\nends')).toThrow(CsvError);
    try {
      readCsv('a,b\n1,"never\nends');
    } catch (err) {
      expect((err as CsvError).line).toBe(2);
    }
  });

  it('handles a large file in one linear pass', () => {
    const big = writeCsv(
      Array.from({ length: 5000 }, (_, i) => [String(i), 'x'.repeat(200), 'a,"b"']),
    );
    expect(readCsv(big)).toHaveLength(5000);
  });
});

describe('spreadsheet files', () => {
  it('reads a CSV: header names tidied, unknown columns ignored, spreadsheet row numbers kept', () => {
    const f = readSheetCsv('ID,Title,Colour,purchase price usd\nA,One,red,1\n,,,\nB,Two,blue,2\n');
    expect(f.errors).toEqual([]);
    expect(f.columns).toEqual(['id', 'title', 'purchase_price_usd']);
    expect(f.unknownColumns).toEqual(['colour']);
    expect(f.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(f.rows[0]?.cells).toEqual({ id: 'A', title: 'One', purchase_price_usd: '1' });
  });

  it('fills short rows with empty cells, so every row carries every column', () => {
    const f = readSheetCsv('id,title,description\nA,One\n');
    expect(f.rows[0]?.cells).toEqual({ id: 'A', title: 'One', description: '' });
  });

  it('refuses a file that names the same item twice, or has no way to match rows', () => {
    expect(readSheetCsv('id,title\nA,x\nA,y\n').errors[0]).toMatch(
      /Rows 2 and 3 are the same item/,
    );
    expect(readSheetCsv('slug,title\ns,x\nt,y\ns,z\n').errors[0]).toMatch(/Rows 2 and 4/);
    expect(readSheetCsv('description\nhello\n').errors[0]).toMatch(/id, slug or title/);
    expect(readSheetCsv('id,id\nA,B\n').errors[0]).toMatch(/twice: id/);
    expect(readSheetCsv('').errors[0]).toMatch(/empty/);
  });

  it('reads a JSON export: lists kept, booleans and numbers as text, missing fields not sent', () => {
    const f = readSheetJson(
      JSON.stringify({
        format: 'collection-gallery-sheet',
        items: [
          {
            id: 'A',
            title: 'One',
            tags: ['x', 'y'],
            open_to_parting: true,
            purchase_price_usd: 12.5,
            extra: 1,
          },
          { id: 'B', description: null },
        ],
      }),
    );
    expect(f.errors).toEqual([]);
    expect(f.columns).toEqual([
      'id',
      'title',
      'description',
      'purchase_price_usd',
      'open_to_parting',
      'tags',
    ]);
    expect(f.unknownColumns).toEqual(['extra']);
    expect(f.rows[0]?.cells).toEqual({
      id: 'A',
      title: 'One',
      tags: ['x', 'y'],
      open_to_parting: 'yes',
      purchase_price_usd: '12.5',
    });
    // Record 2 leaves out the title: it isn't sent, so the server leaves it alone.
    expect(f.rows[1]?.cells).toEqual({ id: 'B', description: '' });
    expect(readSheetJson('[{"id":"A"}]').rows).toHaveLength(1);
  });

  it('rejects JSON that is not an export', () => {
    expect(readSheetJson('{oops').errors[0]).toMatch(/not valid JSON/);
    expect(readSheetJson('{"a":1}').errors[0]).toMatch(/"items" list/);
    expect(readSheetJson('[1]').errors[0]).toMatch(/Record 1 is not an object/);
    expect(readSheetJson('[{"id":"A","title":{"x":1}}]').errors[0]).toMatch(
      /"title" should be text/,
    );
  });

  it('picks the reader by file name or content', () => {
    expect(readSheetFile('items.json', '[{"id":"A"}]').rows[0]?.cells).toEqual({ id: 'A' });
    expect(readSheetFile('items.csv', 'id\nA\n').rows[0]?.cells).toEqual({ id: 'A' });
    expect(readSheetFile('items.txt', ' [{"id":"A"}]').rows).toHaveLength(1);
  });

  it('splits rows into requests by count and by size', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      line: i + 2,
      cells: { title: `t${i}` },
    }));
    expect(sheetBatches(rows).map((b) => b.length)).toEqual([SHEET_BATCH, SHEET_BATCH, 20]);
    const fat = Array.from({ length: 5 }, (_, i) => ({
      line: i + 2,
      cells: { description: 'x'.repeat(400) },
    }));
    expect(sheetBatches(fat, 1000).map((b) => b.length)).toEqual([2, 2, 1]);
    // Apply requests are smaller (SHEET_APPLY_BATCH).
    expect(sheetBatches(rows, undefined, 10)).toHaveLength(12);
  });
});
