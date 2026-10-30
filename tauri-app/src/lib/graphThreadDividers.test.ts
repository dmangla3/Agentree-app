import { describe, expect, it } from 'vitest';
import { buildThreadBands, getThreadDividerRectsFromNodes } from './graphThreadDividers';

describe('graph thread dividers', () => {
  it('uses turn hulls instead of individual conversation nodes when hulls exist', () => {
    const threadRootIdByMessageId = new Map([
      ['thread-a', 'thread-a'],
      ['assistant-a', 'thread-a'],
      ['thread-b', 'thread-b'],
    ]);
    const rects = getThreadDividerRectsFromNodes([
      {
        id: 'group-a',
        type: 'turn_group_hull',
        position: { x: 40, y: 20 },
        style: { width: 300, height: 300 },
        data: { slotKind: 'turn', memberIds: ['assistant-a', 'assistant-a:commit'] },
      } as any,
      {
        id: 'assistant-a',
        type: 'assistant_message',
        parentId: 'group-a',
        position: { x: 20, y: 50 },
        style: { width: 260, height: 120 },
        data: { entity: { messageId: 'assistant-a' } },
      } as any,
      {
        id: 'assistant-a:commit',
        type: 'commit_message',
        parentId: 'group-a',
        position: { x: 320, y: 56 },
        style: { width: 150, height: 118 },
        data: { entity: { threadRootId: 'thread-a', focusMessageId: 'assistant-a' } },
      } as any,
      {
        id: 'group-b',
        type: 'turn_group_hull',
        position: { x: 520, y: 30 },
        style: { width: 260, height: 180 },
        data: { slotKind: 'turn', memberIds: ['thread-b'] },
      } as any,
      {
        id: 'thread-b',
        type: 'user_message',
        parentId: 'group-b',
        position: { x: 20, y: 40 },
        style: { width: 220, height: 80 },
        data: { entity: { threadRootId: 'thread-b', messageId: 'thread-b' } },
      } as any,
    ], threadRootIdByMessageId);

    expect(rects).toEqual([
      {
        id: 'group-a',
        threadRootId: 'thread-a',
        x: 40,
        y: 20,
        width: 300,
        height: 300,
      },
      {
        id: 'group-b',
        threadRootId: 'thread-b',
        x: 520,
        y: 30,
        width: 260,
        height: 180,
      },
    ]);
  });

  it('builds padded thread territory bands from thread rects', () => {
    const bands = buildThreadBands([
      { id: 'a1', threadRootId: 'thread-a', x: 0, y: 20, width: 200, height: 80 },
      { id: 'a2', threadRootId: 'thread-a', x: 20, y: 160, width: 200, height: 90 },
      { id: 'b1', threadRootId: 'thread-b', x: 500, y: 40, width: 200, height: 80 },
    ], { padding: 40, horizontalPadding: 24 });

    expect(bands).toEqual([
      {
        id: 'thread-a',
        threadRootId: 'thread-a',
        left: -24,
        right: 244,
        top: -20,
        bottom: 290,
        count: 2,
      },
      {
        id: 'thread-b',
        threadRootId: 'thread-b',
        left: 476,
        right: 724,
        top: 0,
        bottom: 160,
        count: 1,
      },
    ]);
  });

  it('trims adjacent thread territories so padded bands do not overlap', () => {
    const bands = buildThreadBands([
      { id: 'a1', threadRootId: 'thread-a', x: 0, y: 0, width: 200, height: 80 },
      { id: 'b1', threadRootId: 'thread-b', x: 180, y: 0, width: 200, height: 80 },
    ], { padding: 0, horizontalPadding: 40 });

    expect(bands[0].right).toBe(190);
    expect(bands[1].left).toBe(190);
    expect(bands[0].right).toBeLessThanOrEqual(bands[1].left);
  });

  it('can normalize thread territory bands to a shared lane height', () => {
    const bands = buildThreadBands([
      { id: 'a1', threadRootId: 'thread-a', x: 0, y: 20, width: 200, height: 80 },
      { id: 'a2', threadRootId: 'thread-a', x: 20, y: 260, width: 200, height: 90 },
      { id: 'b1', threadRootId: 'thread-b', x: 500, y: 80, width: 200, height: 80 },
    ], { padding: 40, horizontalPadding: 24, equalVerticalExtent: true });

    expect(bands.map((band) => [band.top, band.bottom])).toEqual([
      [-20, 390],
      [-20, 390],
    ]);
  });
});
