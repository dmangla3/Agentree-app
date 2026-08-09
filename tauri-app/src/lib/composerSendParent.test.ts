import { describe, expect, it } from 'vitest';
import { resolveFocusedCommitSha, resolveSendParentMessageId } from './composerSendParent';

const resolvePersistedMessageId = (messageId: string | null) => (
  messageId === 'optimistic-parent' ? 'persisted-parent' : messageId
);

describe('resolveFocusedCommitSha', () => {
  it('treats graph commit focus as a commit rather than a message parent', () => {
    expect(resolveFocusedCommitSha({
      focusedMessageId: 'commit-1',
      lastFocusSource: 'graph',
      lastFocusMetadata: { commitSha: 'commit-1' },
    })).toBe('commit-1');
  });

  it('ignores commit metadata when focus is on a message node', () => {
    expect(resolveFocusedCommitSha({
      focusedMessageId: 'message-1',
      lastFocusSource: 'graph',
      lastFocusMetadata: { commitSha: 'commit-1' },
    })).toBeNull();
  });
});

describe('resolveSendParentMessageId', () => {
  it('uses the latest focused message at send time', () => {
    expect(resolveSendParentMessageId({
      hasEditDraftSource: false,
      parentMessageIdOverride: undefined,
      focusSnapshot: {
        focusedMessageId: 'new-focus-parent',
        lastFocusSource: 'system',
        lastFocusMetadata: null,
      },
      resolvePersistedMessageId,
    })).toBe('new-focus-parent');
  });

  it('keeps explicit parent override ahead of current focus', () => {
    expect(resolveSendParentMessageId({
      hasEditDraftSource: false,
      parentMessageIdOverride: 'override-parent',
      focusSnapshot: {
        focusedMessageId: 'new-focus-parent',
        lastFocusSource: 'system',
        lastFocusMetadata: null,
      },
      resolvePersistedMessageId,
    })).toBe('override-parent');
  });

  it('keeps edit draft parent ahead of current focus', () => {
    expect(resolveSendParentMessageId({
      hasEditDraftSource: true,
      editDraftSourceParentId: 'draft-parent',
      parentMessageIdOverride: undefined,
      focusSnapshot: {
        focusedMessageId: 'new-focus-parent',
        lastFocusSource: 'system',
        lastFocusMetadata: null,
      },
      resolvePersistedMessageId,
    })).toBe('draft-parent');
  });

  it('does not use a commit sha as a message parent', () => {
    expect(resolveSendParentMessageId({
      hasEditDraftSource: false,
      parentMessageIdOverride: undefined,
      focusSnapshot: {
        focusedMessageId: 'commit-1',
        lastFocusSource: 'graph',
        lastFocusMetadata: { commitSha: 'commit-1' },
      },
      resolvePersistedMessageId,
    })).toBeNull();
  });

  it('normalizes optimistic focus ids to persisted ids', () => {
    expect(resolveSendParentMessageId({
      hasEditDraftSource: false,
      parentMessageIdOverride: undefined,
      focusSnapshot: {
        focusedMessageId: 'optimistic-parent',
        lastFocusSource: 'system',
        lastFocusMetadata: null,
      },
      resolvePersistedMessageId,
    })).toBe('persisted-parent');
  });
});
