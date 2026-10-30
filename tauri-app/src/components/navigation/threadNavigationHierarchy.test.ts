import { describe, expect, it } from 'vitest';
import type { ThreadNavigationItem } from '../graph/GraphControls';
import { getRotatedActiveThreadRootId, orderThreadFamiliesNewestFirst } from './threadNavigationHierarchy';

const thread = (
  threadRootId: string,
  lastUpdatedAt: number,
  parentThreadId: string | null = null,
): ThreadNavigationItem => ({
  threadRootId,
  parentThreadId,
  depth: parentThreadId ? 1 : 0,
  label: threadRootId,
  turnCount: 0,
  commitCount: 0,
  baseCommitSha: null,
  updatedLabel: '',
  runningCount: 0,
  hidden: false,
  done: false,
  current: false,
  lastUpdatedAt,
  unreadCompletedLeafCount: 0,
  initialPreviewNodeId: null,
  previewNodeIds: [],
  draftPreviewText: null,
});

describe('orderThreadFamiliesNewestFirst', () => {
  it('keeps child threads immediately after their parent', () => {
    const items = [
      thread('older-parent', 10),
      thread('older-child', 40, 'older-parent'),
      thread('newer-root', 30),
    ];

    expect(orderThreadFamiliesNewestFirst(items).map((item) => item.threadRootId)).toEqual([
      'older-parent',
      'older-child',
      'newer-root',
    ]);
  });

  it('orders siblings newest first without flattening their hierarchy', () => {
    const items = [
      thread('parent', 10),
      thread('older-child', 20, 'parent'),
      thread('newer-child', 30, 'parent'),
    ];

    expect(orderThreadFamiliesNewestFirst(items).map((item) => item.threadRootId)).toEqual([
      'parent',
      'newer-child',
      'older-child',
    ]);
  });
});

describe('getRotatedActiveThreadRootId', () => {
  it('rotates in navigator order and wraps in both directions', () => {
    const items = [thread('oldest', 10), thread('newest', 30), thread('middle', 20)];

    expect(getRotatedActiveThreadRootId(items, 'newest', 'next')).toBe('middle');
    expect(getRotatedActiveThreadRootId(items, 'oldest', 'next')).toBe('newest');
    expect(getRotatedActiveThreadRootId(items, 'newest', 'previous')).toBe('oldest');
  });

  it('skips closed threads but retains threads with active runs', () => {
    const closed = { ...thread('closed', 30), done: true };
    const closingWhileRunning = { ...thread('running', 20), done: true, runningCount: 1 };
    const active = thread('active', 10);

    expect(getRotatedActiveThreadRootId([closed, closingWhileRunning, active], 'running', 'next')).toBe('active');
    expect(getRotatedActiveThreadRootId([closed, closingWhileRunning, active], 'active', 'next')).toBe('running');
  });
});
