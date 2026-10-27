import { recordSendFlowEvent } from '../perf/sendFlow';
import { useWorkspaceStore } from '../stores/workspaceStore';

interface ComposerSendFocusRegistration {
  flowId: string;
  workspaceId: string;
  assistantMessageId: string;
}

export interface BeginComposerSendFocusInput {
  flowId: string;
  workspaceId: string;
  parentMessageId: string | null;
}

export interface AcceptComposerSendFocusInput {
  flowId: string;
  workspaceId: string;
  userMessageId: string;
  assistantMessageId: string;
  parentMessageId: string | null;
}

export interface FinishComposerSendFocusInput {
  assistantMessageId: string;
  workspaceId?: string | null;
  terminalStatus?: string | null;
  outputCommitSha?: string | null;
}

const focusByAssistantMessageId = new Map<string, ComposerSendFocusRegistration>();
const MAX_TRACKED_COMPOSER_FOCUS_RUNS = 512;

const canAdvanceOwnedFocus = (
  flowId: string,
  allowedCurrentFocusIds: Array<string | null | undefined>,
): boolean => {
  const state = useWorkspaceStore.getState();
  const activeFlow = state.activeSendFlowFocus;
  if (!activeFlow || activeFlow.flowId !== flowId || activeFlow.workspaceId !== state.selectedWorkspaceId) {
    return false;
  }

  const metadataFlowId = typeof state.lastFocusMetadata?.flowId === 'string'
    ? state.lastFocusMetadata.flowId
    : null;
  const userMovedFocus = (
    state.lastFocusSource === 'graph'
    || state.lastFocusSource === 'chat'
    || state.lastFocusSource === 'list'
  ) && state.focusNonce !== activeFlow.ownerFocusNonce && metadataFlowId !== flowId;
  if (userMovedFocus) return false;

  const allowedFocusIds = new Set([
    activeFlow.preferredMessageId,
    ...activeFlow.guardedMessageIds,
    ...allowedCurrentFocusIds,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0));

  return !state.focusedMessageId
    || allowedFocusIds.has(state.focusedMessageId)
    || metadataFlowId === flowId;
};

export const beginComposerSendFocus = (input: BeginComposerSendFocusInput): boolean => {
  const state = useWorkspaceStore.getState();
  if (state.selectedWorkspaceId !== input.workspaceId) return false;

  state.beginSendFlowFocus({
    flowId: input.flowId,
    workspaceId: input.workspaceId,
    preferredMessageId: input.parentMessageId,
    guardedMessageIds: input.parentMessageId ? [input.parentMessageId] : [],
    ownerFocusNonce: state.focusNonce,
    phase: 'optimistic-user',
  });
  recordSendFlowEvent('focus.ownership-started', {
    flowId: input.flowId,
    workspaceId: input.workspaceId,
    parentMessageId: input.parentMessageId,
  }, { source: 'ComposerSendFocus' });
  return true;
};

export const acceptComposerSendFocus = (input: AcceptComposerSendFocusInput): boolean => {
  if (
    !focusByAssistantMessageId.has(input.assistantMessageId)
    && focusByAssistantMessageId.size >= MAX_TRACKED_COMPOSER_FOCUS_RUNS
  ) {
    const oldestAssistantMessageId = focusByAssistantMessageId.keys().next().value;
    if (typeof oldestAssistantMessageId === 'string') {
      focusByAssistantMessageId.delete(oldestAssistantMessageId);
    }
  }
  focusByAssistantMessageId.set(input.assistantMessageId, {
    flowId: input.flowId,
    workspaceId: input.workspaceId,
    assistantMessageId: input.assistantMessageId,
  });

  const allowedFocusIds = [input.parentMessageId, input.userMessageId, input.assistantMessageId];
  if (!canAdvanceOwnedFocus(input.flowId, allowedFocusIds)) {
    recordSendFlowEvent('focus.auto-advance-skipped', {
      flowId: input.flowId,
      workspaceId: input.workspaceId,
      phase: 'real-assistant',
      targetMessageId: input.assistantMessageId,
      reason: 'focus-not-owned',
    }, { source: 'ComposerSendFocus' });
    return false;
  }

  const state = useWorkspaceStore.getState();
  state.advanceSendFlowFocus({
    flowId: input.flowId,
    preferredMessageId: input.assistantMessageId,
    addGuardedMessageIds: [input.userMessageId, input.assistantMessageId],
    phase: 'real-assistant',
  });
  state.dispatchFocus({
    messageId: input.assistantMessageId,
    source: 'composer',
    metadata: {
      phase: 'real-assistant',
      flowId: input.flowId,
    },
  });
  recordSendFlowEvent('focus.auto-advance-applied', {
    flowId: input.flowId,
    workspaceId: input.workspaceId,
    phase: 'real-assistant',
    targetMessageId: input.assistantMessageId,
  }, { source: 'ComposerSendFocus' });
  return true;
};

/** Completes focus ownership from the shared terminal lifecycle, not a composer render effect. */
export const finishComposerSendFocus = (input: FinishComposerSendFocusInput): boolean => {
  const registration = focusByAssistantMessageId.get(input.assistantMessageId);
  if (!registration) return false;
  focusByAssistantMessageId.delete(input.assistantMessageId);

  const state = useWorkspaceStore.getState();
  const workspaceId = input.workspaceId ?? registration.workspaceId;
  const outputCommitSha = input.outputCommitSha?.trim() || null;
  const shouldFocusCommit = Boolean(outputCommitSha) && canAdvanceOwnedFocus(
    registration.flowId,
    [registration.assistantMessageId],
  );

  if (shouldFocusCommit) {
    state.advanceSendFlowFocus({
      flowId: registration.flowId,
      preferredMessageId: registration.assistantMessageId,
      addGuardedMessageIds: [registration.assistantMessageId],
      phase: 'commit',
    });
    state.dispatchFocus({
      messageId: registration.assistantMessageId,
      source: 'composer',
      metadata: {
        reason: 'generated-commit',
        phase: 'generated-commit',
        flowId: registration.flowId,
        assistantMessageId: registration.assistantMessageId,
        commitSha: outputCommitSha,
      },
    });
  }

  state.endSendFlowFocus(registration.flowId);
  recordSendFlowEvent(shouldFocusCommit ? 'commit-focus.applied' : 'commit-focus.skipped', {
    flowId: registration.flowId,
    workspaceId,
    assistantMessageId: registration.assistantMessageId,
    commitSha: outputCommitSha,
    terminalStatus: input.terminalStatus ?? null,
    reason: outputCommitSha ? 'focus-not-owned' : 'no-generated-commit',
  }, { source: 'ComposerSendFocus' });
  return shouldFocusCommit;
};

export const cancelComposerSendFocus = (flowId: string): void => {
  for (const [assistantMessageId, registration] of focusByAssistantMessageId) {
    if (registration.flowId === flowId) focusByAssistantMessageId.delete(assistantMessageId);
  }
  useWorkspaceStore.getState().endSendFlowFocus(flowId);
  recordSendFlowEvent('focus.ownership-cancelled', { flowId }, { source: 'ComposerSendFocus' });
};

export const clearComposerSendFocusRegistry = () => {
  focusByAssistantMessageId.clear();
};
