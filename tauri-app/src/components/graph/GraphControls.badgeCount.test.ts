import { describe, expect, it } from 'vitest';
import { getThreadUnreadBadgeCount } from './GraphControls';

describe('getThreadUnreadBadgeCount', () => {
  it('returns unread completed leaf counts for active threads', () => {
    expect(getThreadUnreadBadgeCount({
      done: false,
      unreadCompletedLeafCount: 3,
    })).toBe(3);
  });

  it('hides unread completed leaf counts for done threads', () => {
    expect(getThreadUnreadBadgeCount({
      done: true,
      unreadCompletedLeafCount: 3,
    })).toBe(0);
  });
});
