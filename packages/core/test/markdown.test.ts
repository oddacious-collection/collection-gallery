/** Restricted Markdown for public text (SEC-06: never raw HTML). */
import { describe, expect, it } from 'vitest';
import { markdownToText, renderInline, renderMarkdown, safeHref } from '../src/public/markdown.ts';

describe('renderMarkdown', () => {
  it('renders the supported subset', () => {
    expect(renderMarkdown('Hello **bold** and *it* and _also_.\nNext line\n\nSecond para')).toBe(
      '<p>Hello <strong>bold</strong> and <em>it</em> and <em>also</em>.<br>Next line</p>\n<p>Second para</p>',
    );
    expect(renderMarkdown('## Origin\n- one\n- two\n\n1. first\n2. second')).toBe(
      '<h2>Origin</h2>\n<ul><li>one</li><li>two</li></ul>\n<ol><li>first</li><li>second</li></ol>',
    );
    expect(renderMarkdown('### Deep', { headingBase: 3 })).toBe('<h4>Deep</h4>');
    expect(renderInline('See [the site](https://example.com/a?b=1&c=2).')).toBe(
      'See <a href="https://example.com/a?b=1&amp;c=2" rel="nofollow noopener noreferrer">the site</a>.',
    );
  });

  it('escapes all HTML and drops unsafe links', () => {
    const out = renderMarkdown(
      '<script>alert(1)</script> <img src=x onerror=alert(1)> "q" \'s\' &amp;',
    );
    expect(out).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &#39;s&#39; &amp;amp;</p>',
    );
    expect(renderInline('[x](javascript:alert(1))')).not.toContain('<a');
    expect(renderInline('[x](data:text/html,hi)')).not.toContain('<a');
    expect(renderInline('[x](  JAVASCRIPT:alert(1))')).not.toContain('<a');
    expect(renderInline('[x"><b>](https://e.com)')).toBe(
      '<a href="https://e.com/" rel="nofollow noopener noreferrer">x&quot;&gt;&lt;b&gt;</a>',
    );
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('//evil.com')).toBeNull();
  });

  it('leaves ordinary text alone', () => {
    expect(renderInline('2*3*4 and snake_case_name and a * b')).toBe(
      '2*3*4 and snake_case_name and a * b',
    );
    expect(renderInline('**unclosed')).toBe('**unclosed');
    expect(renderInline('\\*not italic\\*')).toBe('*not italic*');
  });

  it('is fast on hostile input', () => {
    const started = Date.now();
    renderMarkdown(`${'*'.repeat(50_000)}${'['.repeat(20_000)}${'_a'.repeat(20_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('makes plain text for meta descriptions', () => {
    expect(markdownToText('## Hi\n**Bold** *it*\n\nmore', 100)).toBe('Hi Bold it more');
    expect(markdownToText('x'.repeat(300), 10)).toBe('xxxxxxxxx…');
  });
});
