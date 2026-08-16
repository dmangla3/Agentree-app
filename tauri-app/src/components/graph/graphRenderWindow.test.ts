import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { hasLayoutAnchoredGraphNodes, resolveAnchoredGraphWindowNodeIds } from './graphRenderWindow';

describe('resolveAnchoredGraphWindowNodeIds', () => {
  const nodes = [
    { id: 'thread-origin:one', data: {} },
    { id: 'commit-group:external:one', data: { layoutAnchorNodeId: 'thread-origin:one' } },
    { id: 'other', data: {} },
  ] as Node<any>[];

  it('keeps an anchored import batch with its origin anchor', () => {
    expect([...resolveAnchoredGraphWindowNodeIds(new Set(['commit-group:external:one']), nodes)].sort()).toEqual([
      'commit-group:external:one',
      'thread-origin:one',
    ]);
  });

  it('keeps a visible origin with its anchored import batch', () => {
    expect([...resolveAnchoredGraphWindowNodeIds(new Set(['thread-origin:one']), nodes)].sort()).toEqual([
      'commit-group:external:one',
      'thread-origin:one',
    ]);
  });

  it('detects layout anchors that should not be split by viewport culling', () => {
    expect(hasLayoutAnchoredGraphNodes(nodes)).toBe(true);
    expect(hasLayoutAnchoredGraphNodes([{ id: 'plain', data: {} }] as Node<any>[])).toBe(false);
  });
});
