import type { Agent } from '../hooks/useAgents';
import type { ComposerAgentRunCounts } from '../lib/composerAgentRuns';
import {
  resolveComposerDefaultBaseCommit,
  type ComposerBaseMessage,
  type ComposerCommitPickerRef,
  type ComposerCommitPickerTrackedRef,
  type ComposerDefaultBaseSource,
  type ComposerTargetModeForBase,
} from '../lib/composerBaseCommit';
import { resolveComposerDefaultAgentId } from '../lib/composerModelDefaults';
import { resolveFocusedCommitSha } from '../lib/composerSendParent';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import type { ComposerBaseCommitOverrideState, Message, Workspace } from '../stores/workspaceStore';

export interface GraphDockComposerTarget {
  parentMessageId: string | null;
  selectedNodeId: string | null;
  focusedCommitSha: string | null;
}

export interface GraphDockComposerBase {
  commitSha: string;
  selectedFromNodeId: string | null;
  source: ComposerDefaultBaseSource | 'override' | 'focused-commit';
}

export interface GraphDockComposerKeyInput {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export const shouldSubmitGraphDockComposerKey = (event: GraphDockComposerKeyInput): boolean => (
  event.key === 'Enter' && !event.shiftKey
);

export const toComposerBaseMessages = (messages: Message[]): ComposerBaseMessage[] => (
  messages.map((message) => ({
    id: message.id,
    parentId: message.parentId ?? null,
    output_commit_sha: getMessageOutputCommitSha(message),
    base_commit_sha: message.base_commit_sha ?? null,
  }))
);

export const resolveGraphDockComposerTarget = (input: {
  focusedMessageId: string | null;
  lastFocusSource: string | null;
  lastFocusMetadata: Record<string, unknown> | null;
}): GraphDockComposerTarget => {
  const focusedCommitSha = resolveFocusedCommitSha({
    focusedMessageId: input.focusedMessageId,
    lastFocusSource: input.lastFocusSource,
    lastFocusMetadata: input.lastFocusMetadata,
  });
  const parentMessageId = focusedCommitSha
    ? null
    : input.focusedMessageId;

  return {
    parentMessageId,
    selectedNodeId: input.focusedMessageId,
    focusedCommitSha,
  };
};

export const resolveGraphDockComposerBase = (input: {
  targetMode?: ComposerTargetModeForBase;
  replyParentMessageId: string | null;
  selectedNodeId: string | null;
  focusedCommitSha: string | null;
  messages: Message[];
  refs?: ComposerCommitPickerRef[];
  trackedRefs?: ComposerCommitPickerTrackedRef[];
  workspace: Workspace | null | undefined;
  override: ComposerBaseCommitOverrideState | null;
}): GraphDockComposerBase | null => {
  const override = input.override?.workspaceId === input.workspace?.id ? input.override : null;
  if (override?.commitSha.trim()) {
    return {
      commitSha: override.commitSha.trim(),
      selectedFromNodeId: null,
      source: 'override',
    };
  }

  if (input.focusedCommitSha) {
    return {
      commitSha: input.focusedCommitSha,
      selectedFromNodeId: null,
      source: 'focused-commit',
    };
  }

  const resolution = resolveComposerDefaultBaseCommit({
    targetMode: input.targetMode ?? 'reply',
    replyParentMessageId: input.replyParentMessageId,
    selectedNodeId: input.selectedNodeId,
    messages: toComposerBaseMessages(input.messages),
    refs: input.refs ?? [],
    trackedRefs: input.trackedRefs ?? [],
    workspaceBaseCommitSha: input.workspace?.base_commit_sha ?? null,
  });

  return resolution.sha
    ? {
      commitSha: resolution.sha,
      selectedFromNodeId: resolution.selectedFromNodeId,
      source: resolution.source,
    }
    : null;
};

export const resolveGraphDockComposerAgent = (input: {
  agents: Agent[];
  selectedAgentId: string | null;
  parentMessage: Message | null;
}): Agent | null => {
  const selectedAgent = input.selectedAgentId
    ? input.agents.find((agent) => agent.id === input.selectedAgentId) ?? null
    : null;
  if (selectedAgent) return selectedAgent;

  const defaultAgentId = resolveComposerDefaultAgentId({
    agents: input.agents,
    parentMessage: input.parentMessage,
  });
  return input.agents.find((agent) => agent.id === defaultAgentId) ?? input.agents[0] ?? null;
};

export const resolveGraphDockComposerEffectiveAgentId = (input: {
  selectedAgentId: string | null;
  resolvedAgent: Pick<Agent, 'id'> | null;
}): string | null => (
  input.selectedAgentId ?? input.resolvedAgent?.id ?? null
);

export const resolveGraphDockComposerRunCountsForEffectiveAgent = (input: {
  selectedAgentId: string | null;
  effectiveSelectedAgentId: string | null;
  currentCounts: ComposerAgentRunCounts;
}): ComposerAgentRunCounts => {
  if (input.selectedAgentId || !input.effectiveSelectedAgentId) return input.currentCounts;

  const selectedEntries = Object.entries(input.currentCounts)
    .filter(([, count]) => Number.isFinite(count) && count > 0);
  if (selectedEntries.length === 1 && selectedEntries[0][0] !== input.effectiveSelectedAgentId) {
    return { [input.effectiveSelectedAgentId]: 1 };
  }

  return input.currentCounts;
};
