import { describe, expect, it } from 'vitest';
import type { Annotation, MessageHighlightAnnotation } from '../stores/workspaceStore';
import {
  addOrUpdateMessageHighlight,
  computeHighlightTextHash,
  createHighlightRangeFromOffsets,
  getMessageHighlights,
  removeMessageHighlight,
  updateMessageHighlightColor,
} from './messageHighlights';

const makeHighlight = (
  id: string,
  start: number,
  end: number,
  exact = 'text'
): MessageHighlightAnnotation => ({
  type: 'highlight',
  id,
  color: 'yellow',
  range: {
    start,
    end,
    exact,
    textHash: 'hash',
  },
  createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
  updatedAt: `2026-01-01T00:00:0${id.length}.000Z`,
});

describe('message highlight helpers', () => {
  it('filters and sorts highlight annotations without dropping other annotations', () => {
    const annotations: Annotation[] = [
      { type: 'other', id: 'kept' },
      makeHighlight('second', 12, 16),
      { type: 'highlight', id: '', color: 'yellow' },
      makeHighlight('first', 2, 8),
    ];

    expect(getMessageHighlights(annotations).map((highlight) => highlight.id)).toEqual(['first', 'second']);
  });

  it('adds, updates, and removes one highlight while preserving other annotations', () => {
    const existing: Annotation[] = [{ type: 'other', value: true }, makeHighlight('old', 1, 4)];
    const replacement = { ...makeHighlight('old', 2, 6), color: 'blue' as const };
    const added = addOrUpdateMessageHighlight(existing, makeHighlight('new', 7, 11));
    const updated = addOrUpdateMessageHighlight(added, replacement);
    const recolored = updateMessageHighlightColor(updated, 'new', 'green', '2026-01-02T00:00:00.000Z');
    const removed = removeMessageHighlight(recolored, 'old');

    expect(getMessageHighlights(added).map((highlight) => highlight.id)).toEqual(['old', 'new']);
    expect(getMessageHighlights(updated).find((highlight) => highlight.id === 'old')?.color).toBe('blue');
    expect(getMessageHighlights(recolored).find((highlight) => highlight.id === 'new')?.color).toBe('green');
    expect(removed).toEqual([
      { type: 'other', value: true },
      expect.objectContaining({ id: 'new', color: 'green' }),
    ]);
  });

  it('creates stable range metadata from rendered text offsets', () => {
    const fullText = 'Alpha beta gamma';
    const range = createHighlightRangeFromOffsets(fullText, 6, 10);

    expect(range).toEqual({
      start: 6,
      end: 10,
      exact: 'beta',
      textHash: computeHighlightTextHash(fullText),
    });
    expect(createHighlightRangeFromOffsets(fullText, 2, 2)).toBeNull();
    expect(createHighlightRangeFromOffsets(fullText, 5, 6)).toBeNull();
  });
});
