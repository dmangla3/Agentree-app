import { describe, expect, it } from 'vitest';
import { getPreviewEdgeTypeForLegendHover } from './GraphCanvasIndexPanel';

describe('GraphCanvasIndexPanel legend hover previews', () => {
  it('previews commit-parent edges when the legend row is hovered', () => {
    expect(getPreviewEdgeTypeForLegendHover('git-parent')).toBe('git-parent');
  });

  it('previews convergence context-path edges when the legend row is hovered', () => {
    expect(getPreviewEdgeTypeForLegendHover('context-path')).toBe('context-path');
  });

  it('does not preview ordinary conversation rows on hover', () => {
    expect(getPreviewEdgeTypeForLegendHover('conversation')).toBeNull();
  });
});
