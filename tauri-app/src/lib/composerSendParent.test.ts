import { describe, expect, it } from 'vitest';
import {
  resolveComposerTargetModeAfterSuccessfulSend,
  resolveFocusedCommitSha,
} from './composerSendParent';

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

describe('resolveComposerTargetModeAfterSuccessfulSend', () => {
  it('treats new thread as a one-shot explicit send target', () => {
    expect(resolveComposerTargetModeAfterSuccessfulSend('new-thread')).toBe('reply');
  });
});
