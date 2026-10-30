type FocusSnapshot = {
  focusedMessageId?: string | null;
  lastFocusSource?: string | null;
  lastFocusMetadata?: Record<string, unknown> | null;
};

export type ComposerTargetMode = 'reply' | 'new-thread';

export const resolveFocusedCommitSha = (focusSnapshot: FocusSnapshot): string | null => {
  if (focusSnapshot.lastFocusSource !== 'graph') return null;
  const metadataCommitSha = typeof focusSnapshot.lastFocusMetadata?.commitSha === 'string'
    ? focusSnapshot.lastFocusMetadata.commitSha.trim()
    : '';
  if (!metadataCommitSha) return null;
  return !focusSnapshot.focusedMessageId || focusSnapshot.focusedMessageId === metadataCommitSha
    ? metadataCommitSha
    : null;
};

export const resolveComposerTargetModeAfterSuccessfulSend = (
  targetMode: ComposerTargetMode
): ComposerTargetMode => (
  targetMode === 'new-thread' ? 'reply' : targetMode
);
