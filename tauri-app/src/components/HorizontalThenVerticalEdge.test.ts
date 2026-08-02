import { describe, expect, it } from 'vitest';
import { getVerticalHorizontalVerticalEdgePath } from './HorizontalThenVerticalEdge';

describe('getVerticalHorizontalVerticalEdgePath', () => {
  it('routes offset edges as vertical-horizontal-vertical segments', () => {
    const { path } = getVerticalHorizontalVerticalEdgePath({
      id: 'conversation:a->b',
      sourceX: 100,
      sourceY: 200,
      targetX: 260,
      targetY: 420,
    });

    expect(path).toMatch(/^M 100 200 L 100 \d+ L 260 \d+ L 260 420$/);
  });

  it('collapses to a vertical line when source and target are aligned', () => {
    const { path } = getVerticalHorizontalVerticalEdgePath({
      id: 'conversation:a->b',
      sourceX: 140,
      sourceY: 200,
      targetX: 140,
      targetY: 420,
    });

    expect(path).toBe('M 140 200 L 140 420');
  });
});
