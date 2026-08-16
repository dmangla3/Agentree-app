import { useMemo } from 'react';
import { useAgentRunProjectionStore, type AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message } from '../stores/workspaceStore';
import type { AgentStatus } from '@shared/agentStatus';
import { resolveNodeState } from '../lib/runStateResolver';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import type { LocalNodeMessage } from './useLocalNodes';

// These helpers merge persisted server messages with AgentRunActor projections.
// They should not infer or mutate lifecycle state; lifecycle transitions belong
// in the actor.

const byCreatedAt = (left: { createdAt: string }, right: { createdAt: string }) =>
  new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'error']);

const normalizeLocalTimestamp = (value: unknown, fallbackIso: string): string => {
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') {
      return new Date(numeric).toISOString();
    }
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return fallbackIso;
};

const toMessageFromLocal = (local: LocalNodeMessage, base: Message | null): Message => {
  const payload = local.message;
  const baseExecution = (base?.execution_data ?? {}) as Record<string, any>;
  const localExecution = (payload.execution_data ?? {}) as Record<string, any>;
  const finalizedAtIso = new Date(local.finalizedAt * 1000).toISOString();
  const createdAt = normalizeLocalTimestamp(payload.createdAt ?? base?.createdAt, finalizedAtIso);
  const updatedAt = normalizeLocalTimestamp(payload.updatedAt ?? base?.updatedAt, createdAt);
  return {
    ...(base || {
      id: payload.id,
      role: (payload.role as Message['role']) ?? 'assistant',
      content: '',
      parentId: payload.parentId ?? null,
      workspaceId: payload.workspaceId ?? local.workspaceId,
      createdAt,
      updatedAt,
    }),
    ...payload,
    id: payload.id,
    role: (payload.role as Message['role']) ?? base?.role ?? 'assistant',
    workspaceId: payload.workspaceId ?? base?.workspaceId ?? local.workspaceId,
    parentId: payload.parentId ?? base?.parentId ?? null,
    createdAt,
    updatedAt,
    content: typeof payload.content === 'string' ? payload.content : base?.content ?? '',
    status: (payload.status as any) ?? base?.status ?? null,
    execution_data: {
      ...baseExecution,
      ...localExecution,
      meta: {
        ...(baseExecution.meta || {}),
        ...(localExecution.meta || {}),
      },
      __local_authority: {
        syncStatus: local.syncStatus,
        finalizedAt: local.finalizedAt,
        serverAckAt: local.serverAckAt ?? null,
      },
    },
    promptTokens: payload.promptTokens ?? base?.promptTokens ?? null,
    completionTokens: payload.completionTokens ?? base?.completionTokens ?? null,
    totalTokens: payload.totalTokens ?? base?.totalTokens ?? null,
    output_commit_sha: payload.output_commit_sha ?? base?.output_commit_sha ?? null,
    git_branch_name: payload.git_branch_name ?? base?.git_branch_name ?? null,
    tags: base?.tags ?? payload.tags ?? null,
    comments: base?.comments ?? payload.comments ?? null,
    branchPointers: base?.branchPointers ?? payload.branchPointers ?? null,
  } as Message;
};

export const applyLocalNodeMessages = (
  baseMessages: Message[],
  localMessages: LocalNodeMessage[] | null | undefined,
  workspaceId: string | null,
): Message[] => {
  if (!workspaceId || !localMessages?.length) return baseMessages;
  const merged = new Map<string, Message>(baseMessages.map((message) => [message.id, message]));
  for (const local of localMessages) {
    if (local.workspaceId !== workspaceId) continue;
    merged.set(local.nodeId, toMessageFromLocal(local, merged.get(local.nodeId) ?? null));
  }
  return Array.from(merged.values()).sort(byCreatedAt);
};

const normalizeLiveStatus = (status: string | null | undefined): AgentStatus | null => {
  if (status === 'creating' || status === 'initializing') return 'running';
  return (
    status === 'pending' ||
    status === 'streaming' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'error' ||
    status === 'failed' ||
    status === 'cancelled'
  ) ? status : null;
};

const persistedHasCaughtTerminal = (base: Message | null, live: AgentRunProjectedMessage): boolean => {
  const liveStatus = normalizeLiveStatus(live._optimisticStatus ?? live.status ?? null);
  if (!liveStatus || !TERMINAL_STATUSES.has(liveStatus)) return false;
  const baseStatus = normalizeLiveStatus(base?.status ?? null);
  if (baseStatus !== liveStatus) return false;
  const expectedLength = live._terminalContentLength ?? live.content?.length ?? 0;
  return (base?.content?.length ?? 0) >= expectedLength;
};

const shouldHoldTerminalOverlay = (base: Message | null, live: AgentRunProjectedMessage): boolean => {
  const holdUntil = live._terminalHoldUntil;
  if (typeof holdUntil !== 'number') return false;
  if (persistedHasCaughtTerminal(base, live)) return false;
  return Date.now() < holdUntil;
};

const shouldUseLiveContent = (base: Message | null, live: AgentRunProjectedMessage): boolean => {
  if (live.role === 'user') return true;
  if (shouldHoldTerminalOverlay(base, live)) return true;
  if ((live.content?.length ?? 0) > 0) return true;
  return false;
};

const shouldUseGraphContent = (base: Message | null, live: AgentRunProjectedMessage): boolean => {
  if (live.role === 'user') return true;
  if (shouldHoldTerminalOverlay(base, live)) return true;
  const liveStatus = normalizeLiveStatus(live._optimisticStatus ?? live.status ?? null);
  return !!liveStatus && TERMINAL_STATUSES.has(liveStatus) && (live.content?.length ?? 0) > (base?.content?.length ?? 0);
};

export function mergeLiveMessage(base: Message | null, live: AgentRunProjectedMessage): Message {
  const liveStatus = live._optimisticStatus ?? live.status ?? null;
  const resolved = resolveNodeState(base, live);
  const nextStatus = normalizeLiveStatus(resolved.status) ?? normalizeLiveStatus(liveStatus) ?? normalizeLiveStatus(base?.status ?? null);

  return {
    ...(base || live),
    ...live,
    status: nextStatus,
    content: shouldUseLiveContent(base, live) ? (live.content ?? '') : (base?.content ?? live.content ?? ''),
    execution_data: live.execution_data ?? base?.execution_data ?? null,
    promptTokens: live.promptTokens ?? base?.promptTokens ?? null,
    completionTokens: live.completionTokens ?? base?.completionTokens ?? null,
    totalTokens: live.totalTokens ?? base?.totalTokens ?? null,
    output_commit_sha: live.output_commit_sha ?? base?.output_commit_sha ?? null,
    git_branch_name: live.git_branch_name ?? base?.git_branch_name ?? null,
  };
}

function mergeGraphMessage(base: Message | null, live: AgentRunProjectedMessage): Message {
  const liveStatus = live._optimisticStatus ?? live.status ?? null;
  const resolved = resolveNodeState(base, live);
  const nextStatus = normalizeLiveStatus(resolved.status) ?? normalizeLiveStatus(liveStatus) ?? normalizeLiveStatus(base?.status ?? null);
  const useLiveContent = shouldUseGraphContent(base, live);
  const liveStatusNormalized = normalizeLiveStatus(liveStatus);
  const useTerminalFields = Boolean(liveStatusNormalized && TERMINAL_STATUSES.has(liveStatusNormalized));
  return {
    ...(base || live),
    ...live,
    status: nextStatus,
    updatedAt: useTerminalFields ? (live.updatedAt ?? base?.updatedAt ?? '') : (base?.updatedAt ?? live.updatedAt ?? ''),
    // Graph should not receive continuous streamed body text, but terminal text is safe.
    content: live.role === 'assistant' && !useLiveContent
      ? (base?.content ?? '')
      : (live.content ?? base?.content ?? ''),
    execution_data: base?.execution_data ?? live.execution_data ?? null,
    promptTokens: base?.promptTokens ?? live.promptTokens ?? null,
    completionTokens: base?.completionTokens ?? live.completionTokens ?? null,
    totalTokens: base?.totalTokens ?? live.totalTokens ?? null,
    output_commit_sha: live.output_commit_sha ?? base?.output_commit_sha ?? null,
    git_branch_name: live.git_branch_name ?? base?.git_branch_name ?? null,
  };
}

function toProjectedOnlyMessage(live: AgentRunProjectedMessage): Message {
  const liveStatus = live._optimisticStatus ?? live.status ?? null;
  const nextStatus = normalizeLiveStatus(liveStatus);

  return {
    ...live,
    content: live.role === 'user' || (nextStatus && TERMINAL_STATUSES.has(nextStatus)) ? (live.content ?? '') : '',
    execution_data: live.role === 'user' || (nextStatus && TERMINAL_STATUSES.has(nextStatus)) ? (live.execution_data ?? null) : null,
    promptTokens: live.role === 'user' || (nextStatus && TERMINAL_STATUSES.has(nextStatus)) ? (live.promptTokens ?? null) : null,
    completionTokens: live.role === 'user' || (nextStatus && TERMINAL_STATUSES.has(nextStatus)) ? (live.completionTokens ?? null) : null,
    totalTokens: live.role === 'user' || (nextStatus && TERMINAL_STATUSES.has(nextStatus)) ? (live.totalTokens ?? null) : null,
    status: nextStatus,
  };
}

function mergeLiveMessages(
  baseMessages: Message[],
  projectionsById: Record<string, AgentRunProjectedMessage>,
  workspaceId: string | null
): Message[] {
  if (!workspaceId) return baseMessages;

  const merged = new Map<string, Message>(baseMessages.map((message) => [message.id, message]));

  for (const [nodeId, liveMessage] of Object.entries(projectionsById)) {
    if (liveMessage.workspaceId !== workspaceId) continue;
    merged.set(nodeId, mergeLiveMessage(merged.get(nodeId) || null, liveMessage));
  }

  return Array.from(merged.values()).sort(byCreatedAt);
}

function mergeGraphMessages(
  baseMessages: Message[],
  projectionsById: Record<string, AgentRunProjectedMessage>,
  workspaceId: string | null
): Message[] {
  if (!workspaceId) return baseMessages;

  const merged = new Map<string, Message>(baseMessages.map((message) => [message.id, message]));

  for (const [nodeId, liveMessage] of Object.entries(projectionsById)) {
    if (liveMessage.workspaceId !== workspaceId) continue;
    merged.set(nodeId, mergeGraphMessage(merged.get(nodeId) || null, liveMessage));
  }

  return Array.from(merged.values()).sort(byCreatedAt);
}

export function useWorkspaceMessages(
  workspaceId: string | null,
  baseMessages: Message[],
  localMessages?: LocalNodeMessage[] | null
): Message[] {
  const projectionsById = useAgentRunProjectionStore((state) => state.projectionsById);
  const liveFingerprint = useMemo(() => (
    Object.values(projectionsById)
      .filter((message) => message.workspaceId === workspaceId)
      .map((message) => [
        message.id,
        message.updatedAt ?? '',
        message.status ?? '',
        message._optimisticStatus ?? '',
        message.content?.length ?? 0,
        message._terminalHoldUntil ?? 0,
      ].join('|'))
      .sort()
      .join(';')
  ), [projectionsById, workspaceId]);

  return useMemo(() => {
    const localBaseMessages = applyLocalNodeMessages(baseMessages, localMessages, workspaceId);
    if (!workspaceId || liveFingerprint.length === 0) return localBaseMessages;
    const merged = new Map<string, Message>(localBaseMessages.map((message) => [message.id, message]));
    for (const liveMessage of Object.values(projectionsById)) {
      if (liveMessage.workspaceId !== workspaceId) continue;
      const base = merged.get(liveMessage.id) ?? null;
      merged.set(liveMessage.id, base ? mergeLiveMessage(base, liveMessage) : toProjectedOnlyMessage(liveMessage));
    }
    return Array.from(merged.values()).sort(byCreatedAt);
  }, [baseMessages, workspaceId, projectionsById, liveFingerprint, localMessages]);
}

export function useLiveMessages(
  workspaceId: string | null,
  baseMessages: Message[],
  localMessages?: LocalNodeMessage[] | null
): Message[] {
  const projectionsById = useAgentRunProjectionStore((state) => state.projectionsById);

  return useMemo(() => {
    const localBaseMessages = applyLocalNodeMessages(baseMessages, localMessages, workspaceId);
    return mergeLiveMessages(localBaseMessages, projectionsById, workspaceId);
  }, [baseMessages, workspaceId, projectionsById, localMessages]);
}

export function useGraphMessages(
  workspaceId: string | null,
  baseMessages: Message[],
  localMessages?: LocalNodeMessage[] | null
): Message[] {
  const graphOverlayFingerprint = useAgentRunProjectionStore((state) => {
    if (!workspaceId) return '';
    return Object.values(state.projectionsById)
      .filter((message) => message.workspaceId === workspaceId)
      .map((message) => {
        const status = normalizeLiveStatus(message._optimisticStatus ?? message.status ?? null);
        const terminalContentLength = status && TERMINAL_STATUSES.has(status)
          ? (message.content?.length ?? 0)
          : 0;
        return [
          message.id,
          message.workspaceId,
          message.parentId ?? '',
          message.role,
          message.agent_id ?? '',
          message.createdAt ?? '',
          message.status ?? '',
          message._optimisticStatus ?? '',
          message.aiLabel ?? '',
          terminalContentLength,
          status && TERMINAL_STATUSES.has(status) ? (message._terminalHoldUntil ?? 0) : 0,
          getMessageOutputCommitSha(message) ?? '',
          message.git_branch_name ?? '',
        ].join('|');
      })
      .sort()
      .join(';');
  });

  return useMemo(() => {
    const localBaseMessages = applyLocalNodeMessages(baseMessages, localMessages, workspaceId);
    return mergeGraphMessages(localBaseMessages, useAgentRunProjectionStore.getState().projectionsById, workspaceId);
  }, [baseMessages, workspaceId, graphOverlayFingerprint, localMessages]);
}
