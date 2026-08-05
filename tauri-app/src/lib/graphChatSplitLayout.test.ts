import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAPH_CHAT_SPLIT,
  getGraphChatRestoreSplit,
  normalizeGraphChatSplit,
  shouldRememberGraphChatSplit,
} from './graphChatSplitLayout';

describe('graph/chat split layout helpers', () => {
  it('defaults to an equal 50/50 graph and chat split', () => {
    expect(DEFAULT_GRAPH_CHAT_SPLIT).toEqual([50, 50]);
  });

  it('remembers user-resized non-collapsed layouts', () => {
    expect(shouldRememberGraphChatSplit([42, 58])).toBe(true);
    expect(normalizeGraphChatSplit([42, 58])).toEqual([42, 58]);
  });

  it('does not remember collapsed or nearly-collapsed chat layouts as the restore target', () => {
    expect(shouldRememberGraphChatSplit([100, 0])).toBe(false);
    expect(shouldRememberGraphChatSplit([96, 4])).toBe(false);
    expect(shouldRememberGraphChatSplit([90, 10])).toBe(false);
  });

  it('restores the last remembered split when it is valid', () => {
    expect(getGraphChatRestoreSplit([37, 63])).toEqual([37, 63]);
  });

  it('falls back to 50/50 when the remembered split is invalid', () => {
    expect(getGraphChatRestoreSplit(null)).toEqual([50, 50]);
    expect(getGraphChatRestoreSplit([100, 0])).toEqual([50, 50]);
    expect(getGraphChatRestoreSplit([120, -20])).toEqual([50, 50]);
  });
});
