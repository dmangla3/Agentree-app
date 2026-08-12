type FocusSnapshot = {
  focusedMessageId?: string | null;
  lastFocusSource?: string | null;
  lastFocusMetadata?: Record<string, unknown> | null;
};

export type ComposerTargetMode = 'reply' | 'new-thread';

export type ResolveSendParentMessageIdInput = {
  hasEditDraftSource: boolean;
  editDraftSourceParentId?: string | null;
  parentMessageIdOverride?: string | null;
  forceRootParent?: boolean;
  focusSnapshot: FocusSnapshot;
  resolvePersistedMessageId: (messageId: string | null) => string | null;
};

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

export const resolveSendParentMessageId = ({
  hasEditDraftSource,
  editDraftSourceParentId = null,
  parentMessageIdOverride,
  forceRootParent = false,
  focusSnapshot,
  resolvePersistedMessageId,
}: ResolveSendParentMessageIdInput): string | null => {
  if (forceRootParent && !hasEditDraftSource) return null;

  const focusedCommitSha = resolveFocusedCommitSha(focusSnapshot);
  const rawParentId = hasEditDraftSource
    ? editDraftSourceParentId
    : parentMessageIdOverride !== undefined
      ? parentMessageIdOverride
      : focusedCommitSha
        ? null
        : focusSnapshot.focusedMessageId ?? null;

  return resolvePersistedMessageId(rawParentId ?? null);
};

export const resolveComposerTargetModeAfterSuccessfulSend = (
  targetMode: ComposerTargetMode
): ComposerTargetMode => (
  targetMode === 'new-thread' ? 'reply' : targetMode
);
