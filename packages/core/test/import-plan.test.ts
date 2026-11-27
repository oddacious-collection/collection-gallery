/** The Instagram import plan file format (D-62, D-70). */
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parseImportPlan, planFor } from '../src/import/plan.ts';

const post = (over: Record<string, unknown> = {}) => ({
  index: 0,
  timestamp: 1_711_843_200,
  action: 'import',
  title: 'Gibeon - Iron, IVA',
  titleConfidence: 'high',
  ...over,
});
const plan = (posts: unknown[]) => JSON.stringify({ version: 1, source: 'instagram', posts });

describe('import plan file', () => {
  it('reads a plan and finds a post by its timestamp', () => {
    const p = parseImportPlan(
      plan([
        post(),
        post({
          index: 1,
          timestamp: 1_711_843_100,
          action: 'maybe-skip',
          title: 'Spider and Fly in Baltic Amber',
          titleConfidence: 'medium',
          note: 'Posted four times; keep one.',
          duplicateGroup: 'amber-spider-fly',
          captionEdits: [{ remove: 'Just kidding.' }],
        }),
      ]),
    );
    expect(planFor(p, 1_711_843_100)?.duplicateGroup).toBe('amber-spider-fly');
    expect(planFor(p, 42)).toBeUndefined();
  });

  it('refuses unknown fields, bad values and two entries for one post', () => {
    const bad = (posts: unknown[]) => () => parseImportPlan(plan(posts));
    expect(bad([post({ extra: 1 })])).toThrow(ZodError);
    expect(bad([post({ action: 'delete' })])).toThrow(ZodError);
    expect(bad([post({ title: '   ' })])).toThrow(ZodError);
    expect(bad([post({ duplicateGroup: 'Has Spaces' })])).toThrow(ZodError);
    expect(bad([post(), post({ index: 1 })])).toThrow(/same post/);
    expect(() => parseImportPlan('{"version":2,"source":"instagram","posts":[]}')).toThrow(
      ZodError,
    );
    expect(() => parseImportPlan('not json')).toThrow(SyntaxError);
  });
});
