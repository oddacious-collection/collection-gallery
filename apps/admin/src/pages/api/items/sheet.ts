/**
 * The spreadsheet export and import (IMP-06, D-71).
 *
 * GET  /api/items/sheet?format=csv|json — every item not in the trash, all
 *      fields (admin ones too), as a download. CSV cells are formula-protected.
 * POST /api/items/sheet {mode, columns, rows} — preview or apply up to 50 rows
 *      the browser read from a file; each row succeeds or fails on its own.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  LIST_SEPARATOR,
  SHEET_COLUMNS,
  SheetRows,
  actorOf,
  api,
  exportSheet,
  json,
  processSheetRows,
  readJson,
} from '@cg/core/admin';
import { writeCsv } from '@cg/core/import';

/** Big enough for 50 rows with long descriptions; the browser batches to fit. */
const MAX_SHEET_BYTES = 1024 * 1024;

export const GET: APIRoute = async ({ url }) => {
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
  const records = await exportSheet(env.DB);
  const day = new Date().toISOString().slice(0, 10);
  const headers = {
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="collection-${day}.${format}"`,
  };
  if (format === 'json') {
    const body = JSON.stringify(
      {
        format: 'collection-gallery-sheet',
        version: 1,
        exportedAt: new Date().toISOString(),
        columns: SHEET_COLUMNS,
        items: records,
      },
      null,
      2,
    );
    return new Response(body, {
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const rows = [
    [...SHEET_COLUMNS],
    ...records.map((r) =>
      SHEET_COLUMNS.map((c) => {
        const v = r[c];
        return Array.isArray(v) ? v.join(LIST_SEPARATOR) : (v ?? '');
      }),
    ),
  ];
  return new Response(writeCsv(rows), {
    headers: { ...headers, 'content-type': 'text/csv; charset=utf-8' },
  });
};

export const POST: APIRoute = ({ request }) =>
  api(async () => {
    const input = SheetRows.parse(await readJson(request, MAX_SHEET_BYTES));
    return json({ results: await processSheetRows(env.DB, input, actorOf(request)) });
  });
