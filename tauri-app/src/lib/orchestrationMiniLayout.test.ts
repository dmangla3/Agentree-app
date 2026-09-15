import { describe, expect, it } from 'vitest';
import {
  getOrchestrationMiniGridPosition,
  getOrchestrationMiniLayoutPositions,
} from './orchestrationMiniLayout';

const children = (ids: string[]) => ids.map((id) => ({ id }));

describe('orchestration mini graph layout', () => {
  it('keeps the old compact grid when there are no semantic edges', () => {
    const positions = getOrchestrationMiniLayoutPositions(children(['a', 'b', 'c']), []);

    expect(positions.get('a')).toEqual(getOrchestrationMiniGridPosition(0, 3));
    expect(positions.get('b')).toEqual(getOrchestrationMiniGridPosition(1, 3));
    expect(positions.get('c')).toEqual(getOrchestrationMiniGridPosition(2, 3));
  });

  it('places a simple chain by increasing depth', () => {
    const positions = getOrchestrationMiniLayoutPositions(
      children(['a', 'b', 'c']),
      [
        { sourceId: 'a', targetId: 'b' },
        { sourceId: 'b', targetId: 'c' },
      ],
    );

    expect(positions.get('a')?.x).toBe(50);
    expect(positions.get('b')?.x).toBe(50);
    expect(positions.get('c')?.x).toBe(50);
    expect(positions.get('a')!.y).toBeLessThan(positions.get('b')!.y);
    expect(positions.get('b')!.y).toBeLessThan(positions.get('c')!.y);
  });

  it('places siblings on the same row below their parent', () => {
    const positions = getOrchestrationMiniLayoutPositions(
      children(['parent', 'left', 'right']),
      [
        { sourceId: 'parent', targetId: 'left' },
        { sourceId: 'parent', targetId: 'right' },
      ],
    );

    expect(positions.get('parent')?.x).toBe(50);
    expect(positions.get('parent')!.y).toBeLessThan(positions.get('left')!.y);
    expect(positions.get('left')?.y).toBe(positions.get('right')?.y);
    expect(positions.get('left')!.x).toBeLessThan(positions.get('right')!.x);
  });

  it('keeps five parallel orchestration runs on one visual row', () => {
    const positions = getOrchestrationMiniLayoutPositions(
      children(['root', 'a', 'b', 'c', 'd', 'e']),
      [
        { sourceId: 'root', targetId: 'a' },
        { sourceId: 'root', targetId: 'b' },
        { sourceId: 'root', targetId: 'c' },
        { sourceId: 'root', targetId: 'd' },
        { sourceId: 'root', targetId: 'e' },
      ],
    );

    const childRows = new Set(['a', 'b', 'c', 'd', 'e'].map((id) => positions.get(id)?.y));
    expect(childRows.size).toBe(1);
    expect(positions.get('root')!.y).toBeLessThan(positions.get('a')!.y);
  });

  it('wraps wide sibling fan-out across rows', () => {
    const positions = getOrchestrationMiniLayoutPositions(
      children(['root', 'a', 'b', 'c', 'd', 'e', 'f']),
      [
        { sourceId: 'root', targetId: 'a' },
        { sourceId: 'root', targetId: 'b' },
        { sourceId: 'root', targetId: 'c' },
        { sourceId: 'root', targetId: 'd' },
        { sourceId: 'root', targetId: 'e' },
        { sourceId: 'root', targetId: 'f' },
      ],
    );

    const childRows = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => positions.get(id)?.y));
    expect(childRows.size).toBeGreaterThan(1);
    expect(positions.get('root')!.y).toBeLessThan(positions.get('a')!.y);
  });

  it('packs a partial child row around its parent instead of stretching edge length', () => {
    const positions = getOrchestrationMiniLayoutPositions(
      children(['root', 'a', 'b', 'c', 'd', 'e', 'left-child', 'right-child']),
      [
        { sourceId: 'root', targetId: 'a' },
        { sourceId: 'root', targetId: 'b' },
        { sourceId: 'root', targetId: 'c' },
        { sourceId: 'root', targetId: 'd' },
        { sourceId: 'root', targetId: 'e' },
        { sourceId: 'a', targetId: 'left-child' },
        { sourceId: 'a', targetId: 'right-child' },
      ],
    );

    expect(positions.get('left-child')?.x).toBe(positions.get('a')?.x);
    expect(positions.get('right-child')!.x).toBeLessThan(50);
    expect(positions.get('left-child')?.y).toBe(positions.get('right-child')?.y);
  });

  it('centers a fan-in child beneath its parents', () => {
    const positions = getOrchestrationMiniLayoutPositions(
      children(['left', 'right', 'join']),
      [
        { sourceId: 'left', targetId: 'join' },
        { sourceId: 'right', targetId: 'join' },
      ],
    );

    expect(positions.get('left')?.y).toBe(positions.get('right')?.y);
    expect(positions.get('join')?.x).toBe(50);
    expect(positions.get('join')!.y).toBeGreaterThan(positions.get('left')!.y);
  });

  it('falls back to the compact grid for cyclic mini graphs', () => {
    const positions = getOrchestrationMiniLayoutPositions(
      children(['a', 'b']),
      [
        { sourceId: 'a', targetId: 'b' },
        { sourceId: 'b', targetId: 'a' },
      ],
    );

    expect(positions.get('a')).toEqual(getOrchestrationMiniGridPosition(0, 2));
    expect(positions.get('b')).toEqual(getOrchestrationMiniGridPosition(1, 2));
  });
});
