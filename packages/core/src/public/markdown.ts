/**
 * Restricted Markdown → HTML for public text (item and category descriptions;
 * SEC-06: no raw HTML, ever).
 *
 * Supported: paragraphs (blank line), line breaks (single newline), headings
 * (`## `, `### `), bullet lists (`- `, `* `), numbered lists (`1. `),
 * **bold**, *italic*, and [links](https://…) to http, https and mailto only.
 * Everything else is shown as plain text.
 *
 * Safety: every character of input text goes through `escapeHtml` before it
 * is placed in the output; the only tags emitted are the fixed ones above.
 * Parsing is a linear scan with no backtracking regular expressions (ReDoS).
 */

export function escapeHtml(s: string): string {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#39;';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** A link target we allow, or null. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0 || url.length > 2000) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'mailto:'
  ) {
    return null;
  }
  return parsed.href;
}

/** Inline formatting of one line or paragraph of text. */
export function renderInline(text: string): string {
  let out = '';
  let i = 0;
  let strong = false;
  let em: string | null = null;
  const isSpace = (c: string) => c === ' ' || c === '\t';
  const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length && '*_[]()\\'.includes(text[i + 1] ?? '')) {
      out += escapeHtml(text[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '*' && text[i + 1] === '*') {
      if (strong || text.indexOf('**', i + 2) !== -1) {
        out += strong ? '</strong>' : '<strong>';
        strong = !strong;
        i += 2;
        continue;
      }
    } else if (ch === '*' || ch === '_') {
      // Only markers at word boundaries count, so "2*3*4" and snake_case stay text.
      const prev = i === 0 ? ' ' : (text[i - 1] ?? ' ');
      const next = text[i + 1] ?? ' ';
      if (em === ch && !isSpace(prev)) {
        out += '</em>';
        em = null;
        i += 1;
        continue;
      }
      if (em === null && !isWordChar(prev) && !isSpace(next) && text.indexOf(ch, i + 1) !== -1) {
        out += '<em>';
        em = ch;
        i += 1;
        continue;
      }
    } else if (ch === '[') {
      const close = text.indexOf('](', i + 1);
      const end = close === -1 ? -1 : text.indexOf(')', close + 2);
      if (close !== -1 && end !== -1 && !text.slice(i + 1, close).includes('[')) {
        const href = safeHref(text.slice(close + 2, end));
        const label = text.slice(i + 1, close);
        if (href && label.trim()) {
          out += `<a href="${escapeHtml(href)}" rel="nofollow noopener noreferrer">${renderInline(label)}</a>`;
          i = end + 1;
          continue;
        }
      }
    }
    out += escapeHtml(ch ?? '');
    i += 1;
  }
  if (em !== null) out += '</em>';
  if (strong) out += '</strong>';
  return out;
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: 2 | 3; text: string }
  | { kind: 'ul' | 'ol'; items: string[] };

function listMarker(line: string): { kind: 'ul' | 'ol'; text: string } | null {
  const t = line.trimStart();
  if ((t.startsWith('- ') || t.startsWith('* ')) && t.length > 2)
    return { kind: 'ul', text: t.slice(2) };
  let n = 0;
  while (n < t.length && n < 4 && t.charCodeAt(n) >= 48 && t.charCodeAt(n) <= 57) n++;
  if (n > 0 && (t[n] === '.' || t[n] === ')') && t[n + 1] === ' ')
    return { kind: 'ol', text: t.slice(n + 2) };
  return null;
}

/** Renders restricted Markdown to safe HTML. `headingBase` shifts heading levels (2 → h2). */
export function renderMarkdown(source: string, opts: { headingBase?: 2 | 3 } = {}): string {
  const base = opts.headingBase ?? 2;
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', lines: para });
    para = [];
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flush();
      continue;
    }
    const t = line.trimStart();
    if (t.startsWith('### ') || t.startsWith('## ')) {
      flush();
      const level = t.startsWith('### ') ? 3 : 2;
      blocks.push({ kind: 'h', level, text: t.slice(level + 1).trim() });
      continue;
    }
    const li = listMarker(line);
    if (li) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === li.kind) last.items.push(li.text);
      else blocks.push({ kind: li.kind, items: [li.text] });
      continue;
    }
    para.push(line.trim());
  }
  flush();

  return blocks
    .map((b) => {
      if (b.kind === 'p') return `<p>${b.lines.map(renderInline).join('<br>')}</p>`;
      if (b.kind === 'h') {
        const level = Math.min(6, b.level + (base - 2));
        return `<h${level}>${renderInline(b.text)}</h${level}>`;
      }
      return `<${b.kind}>${b.items.map((x) => `<li>${renderInline(x)}</li>`).join('')}</${b.kind}>`;
    })
    .join('\n');
}

/** Plain text of restricted Markdown (for meta descriptions): markers removed, whitespace collapsed. */
export function markdownToText(source: string, max = 200): string {
  let s = '';
  for (const ch of source)
    s += ch === '*' || ch === '_' || ch === '#' ? '' : ch === '\n' ? ' ' : ch;
  const collapsed = s.split(/\s+/).filter(Boolean).join(' ');
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}
