/**
 * The spreadsheet page (IMP-06, D-71): reads the edited file here, asks the
 * server what each row would change (preview), then, on request, applies the
 * rows that have changes. Text is set with textContent only (Trusted Types).
 */
import {
  SHEET_APPLY_BATCH,
  SHEET_BATCH,
  readSheetFile,
  sheetBatches,
  type SheetFile,
  type SheetFileRow,
} from '@cg/core/import';

const CSRF = { 'x-cg-request': '1' };

interface RowResult {
  line: number;
  action: 'create' | 'update' | 'unchanged' | 'error';
  itemId?: string;
  title: string;
  changes: { field: string; from: string; to: string }[];
  errors: string[];
  applied?: boolean;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
const fileInput = $<HTMLInputElement>('[data-sheet-file]');
const previewButton = $<HTMLButtonElement>('[data-sheet-preview]');
const message = $<HTMLElement>('[data-sheet-message]');
const resultCard = $<HTMLElement>('[data-sheet-result]');
const heading = $<HTMLElement>('[data-sheet-result-heading]');
const totals = $<HTMLElement>('[data-sheet-totals]');
const applyButton = $<HTMLButtonElement>('[data-sheet-apply]');
const progress = $<HTMLElement>('[data-sheet-progress]');
const report = $<HTMLOListElement>('[data-sheet-report]');

class Stop extends Error {}

const short = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one === '' ? '(empty)' : one.length > 90 ? `“${one.slice(0, 87)}…”` : `“${one}”`;
};

if (
  fileInput &&
  previewButton &&
  message &&
  resultCard &&
  heading &&
  totals &&
  applyButton &&
  progress &&
  report
) {
  let file: SheetFile | null = null;
  let toApply: SheetFileRow[] = [];

  const say = (el: HTMLElement, text: string, ok = true) => {
    el.textContent = text;
    el.classList.toggle('error', !ok);
  };

  const send = async (mode: 'preview' | 'apply', rows: SheetFileRow[], columns: string[]) => {
    const res = await fetch('/api/items/sheet', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...CSRF, 'content-type': 'application/json' },
      body: JSON.stringify({ mode, columns, rows }),
    });
    if (res.status === 403)
      throw new Stop('Your session has expired. Reload the page to sign in again.');
    if (res.status === 400) {
      const data = (await res.json().catch(() => ({}))) as { issues?: { path: string }[] };
      // A path like rows.3.cells.description: name the file's row and column.
      const path = data.issues?.[0]?.path ?? '';
      const [, index, column] = /^rows\.(\d+)(?:\.cells\.([a-z_]+))?/.exec(path) ?? [];
      const row = index === undefined ? undefined : rows[Number(index)];
      const where = row ? ` (row ${row.line}${column ? `, ${column}` : ''})` : '';
      throw new Stop(`The server couldn’t read part of the file${where}. Check the cells.`);
    }
    if (!res.ok) throw new Stop('Something went wrong on the server. Try again.');
    return ((await res.json()) as { results: RowResult[] }).results;
  };

  const run = async (mode: 'preview' | 'apply', rows: SheetFileRow[], columns: string[]) => {
    const out: RowResult[] = [];
    const maxRows = mode === 'preview' ? SHEET_BATCH : SHEET_APPLY_BATCH;
    for (const batch of sheetBatches(rows, undefined, maxRows)) {
      out.push(...(await send(mode, batch, columns)));
      say(
        progress,
        `${mode === 'preview' ? 'Checking' : 'Saving'}… ${out.length} of ${rows.length} rows.`,
      );
    }
    return out;
  };

  const show = (results: RowResult[], applied: boolean) => {
    while (report.firstChild) report.removeChild(report.firstChild);
    const n = (a: RowResult['action']) => results.filter((r) => r.action === a).length;
    const failed = results.filter((r) => r.applied === false).length;
    if (applied) {
      const done = results.filter((r) => r.applied).length;
      say(
        totals,
        `Saved ${done} row${done === 1 ? '' : 's'}${failed ? `; ${failed} couldn’t be saved (below)` : ''}.`,
        !failed,
      );
    } else {
      const parts = [
        `${n('create')} new`,
        `${n('update')} changed`,
        `${n('unchanged')} unchanged`,
        `${n('error')} with problems`,
      ];
      say(
        totals,
        `${parts.join(', ')}.${n('error') ? ' Rows with problems are skipped; fix them in the file and preview again to include them.' : ''}`,
        n('error') === 0,
      );
    }
    for (const r of results) {
      if (r.action === 'unchanged') continue;
      const li = document.createElement('li');
      const head = document.createElement('p');
      const label =
        r.applied === false || r.action === 'error'
          ? 'Problem'
          : r.action === 'create'
            ? applied
              ? 'Created'
              : 'New draft'
            : applied
              ? 'Saved'
              : 'Changes';
      head.appendChild(document.createTextNode(`Row ${r.line} · ${label}: `));
      if (r.itemId) {
        const a = document.createElement('a');
        a.href = `/items/${r.itemId}`;
        a.textContent = r.title;
        head.appendChild(a);
      } else {
        head.appendChild(document.createTextNode(r.title));
      }
      li.appendChild(head);
      if (r.errors.length) {
        li.classList.add('sheet-problem');
        const ul = document.createElement('ul');
        for (const e of r.errors) {
          const item = document.createElement('li');
          item.textContent = e;
          ul.appendChild(item);
        }
        li.appendChild(ul);
      }
      if (r.changes.length && !(applied && r.applied === false)) {
        const ul = document.createElement('ul');
        ul.className = 'sheet-changes';
        for (const c of r.changes) {
          const item = document.createElement('li');
          item.textContent =
            // A new item (or a refused new one) has nothing to change from.
            r.action === 'create' || !r.itemId
              ? `${c.field}: ${short(c.to)}`
              : `${c.field}: ${short(c.from)} → ${short(c.to)}`;
          ul.appendChild(item);
        }
        li.appendChild(ul);
      }
      report.appendChild(li);
    }
  };

  fileInput.addEventListener('change', () => {
    file = null;
    toApply = [];
    resultCard.hidden = true;
    say(message, '');
  });

  previewButton.addEventListener('click', () => {
    const picked = fileInput.files?.[0];
    if (!picked) {
      say(message, 'Choose the file first.', false);
      return;
    }
    previewButton.disabled = true;
    applyButton.hidden = true;
    void (async () => {
      try {
        file = readSheetFile(picked.name, await picked.text());
        if (file.errors.length) {
          const more = file.errors.length > 5 ? ` (and ${file.errors.length - 5} more)` : '';
          say(message, `${file.errors.slice(0, 5).join(' ')}${more}`, false);
          return;
        }
        if (file.rows.length === 0) {
          say(message, 'The file has no rows.', false);
          return;
        }
        say(
          message,
          `${file.rows.length} rows, ${file.columns.length} columns.${file.unknownColumns.length ? ` Ignored columns: ${file.unknownColumns.join(', ')}.` : ''}`,
        );
        heading.textContent = '3. What will change';
        resultCard.hidden = false;
        const results = await run('preview', file.rows, file.columns);
        say(progress, '');
        show(results, false);
        const lines = new Set(
          results.filter((r) => r.action === 'create' || r.action === 'update').map((r) => r.line),
        );
        toApply = file.rows.filter((r) => lines.has(r.line));
        applyButton.textContent = `Apply ${toApply.length} change${toApply.length === 1 ? '' : 's'}`;
        applyButton.hidden = toApply.length === 0;
      } catch (err) {
        say(
          message,
          err instanceof Stop
            ? err.message
            : err instanceof TypeError
              ? 'Network error. Try again.'
              : err instanceof Error
                ? `The file couldn’t be read: ${err.message}`
                : 'The file couldn’t be read.',
          false,
        );
        say(progress, '');
      } finally {
        previewButton.disabled = false;
      }
    })();
  });

  applyButton.addEventListener('click', () => {
    if (!file || toApply.length === 0) return;
    const columns = file.columns;
    const rows = toApply;
    applyButton.disabled = true;
    previewButton.disabled = true;
    void (async () => {
      try {
        const results = await run('apply', rows, columns);
        say(progress, '');
        heading.textContent = '3. Done';
        show(results, true);
        // Applying twice would create new drafts twice: preview again first.
        applyButton.hidden = true;
        toApply = [];
      } catch (err) {
        say(
          progress,
          err instanceof Stop
            ? `${err.message} Rows before this point were saved; preview again to see what is left.`
            : 'Network error. Preview again to see what was saved.',
          false,
        );
        applyButton.hidden = true;
        toApply = [];
      } finally {
        applyButton.disabled = false;
        previewButton.disabled = false;
      }
    })();
  });
}
