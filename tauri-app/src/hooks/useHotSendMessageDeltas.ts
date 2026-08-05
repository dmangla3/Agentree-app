import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { recordPerfEvent, getElapsedSinceAppStartMs } from '../lib/perfRecorder';
import type { Message, BranchPointer, TrackedGitRef } from '../stores/workspaceStore';
import { useRunStatusStore } from '../stores/runStatusStore';
import type { GraphSnapshot, GraphSnapshotMessage } from './useGraphSnapshot';
import { branchKeys } from './useBranches';
import { trackedRefKeys } from './useTrackedRefs';
import { localNodeKeys } from './useLocalNodes';
import { agentClient } from '../lib/agentClient';
import { applyLocalNodeMessages } from './useLiveMessages';

type MessageDeltaPayload = Partial<Message> & {
  id: string;
  role: Message['role'];
  workspaceId: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  contentPreview?: string;
  contentLength?: number;
  payload_kind?: 'graph_safe_message' | 'full_message';
};

type MessageDeltaEvent = {
  seq: number;
  type: 'message_created' | 'message_updated' | 'message_deleted';
  workspaceId: string;
  entityId: string;
  occurredAt: string;
  message: MessageDeltaPayload | null;
};

type MessageDeltaResponse = {
  version: number;
  workspaceId: string;
  sinceCursor: number;
  nextCursor: number;
  hasMore: boolean;
  events: MessageDeltaEvent[];
};

type GraphBootstrapResponse = {
  version: number;
  workspaceId: string;
  graphSnapshot: GraphSnapshot;
  trackedRefs?: TrackedGitRef[];
  branchPointers?: BranchPointer[];
  messageCursor?: number;
  refCursor?: number | null;
};

const POLL_MS = 2_500;
const TERMINAL_GRACE_MS = 3_000;

// This hook is deliberately scoped to hot-send repair/catch-up. It is not yet a
// complete collaboration sync layer; expanding it requires complete mutation
// coverage and a stricter payload policy for full message content.
const seededCursorByWorkspace = new Map<string, number>();
const cursorSeedListeners = new Set<(workspaceId: string) => void>();
const catchupInFlightByWorkspace = new Set<string>();

const sortByCreatedAt = (left: { createdAt: string }, right: { createdAt: string }) =>
  new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();

const graphSnapshotMessageFromDelta = (
  current: GraphSnapshotMessage | undefined,
  delta: MessageDeltaPayload
): GraphSnapshotMessage => ({
  ...(current || {
    id: delta.id,
    role: delta.role,
    parentId: delta.parentId ?? null,
    workspaceId: delta.workspaceId,
    createdAt: delta.createdAt,
    updatedAt: delta.updatedAt,
  }),
  ...delta,
  contentPreview: delta.contentPreview ?? current?.contentPreview ?? '',
  contentLength: delta.contentLength ?? current?.contentLength ?? (typeof delta.content === 'string' ? delta.content.length : 0),
});

const applyMessageEventsToGraphSnapshot = (
  current: GraphSnapshot | undefined,
  events: MessageDeltaEvent[]
): GraphSnapshot | undefined => {
  if (!current) return current;
  const next = new Map<string, GraphSnapshotMessage>(current.messages.map((message) => [message.id, message]));

  for (const event of events) {
    if (event.type === 'message_deleted') {
      next.delete(event.entityId);
      continue;
    }
    if (!event.message) continue;
    const existing = next.get(event.message.id);
    next.set(event.message.id, graphSnapshotMessageFromDelta(existing, event.message));
  }

  return {
    ...current,
    generatedAt: new Date().toISOString(),
    messages: Array.from(next.values()).sort(sortByCreatedAt),
  };
};

const shouldRepairFromEvents = (events: MessageDeltaEvent[], existingMessages: Message[] | undefined) => {
  if (!events.length || !existingMessages) return false;
  const byId = new Set(existingMessages.map((message) => message.id));
  for (const event of events) {
    if (event.type !== 'message_created' || !event.message?.parentId) continue;
    if (!byId.has(event.message.parentId)) return true;
    byId.add(event.message.id);
  }
  return false;
};

const invalidateLocalNodesForDeletedEvents = (
  queryClient: QueryClient,
  workspaceId: string,
  events: MessageDeltaEvent[]
) => {
  const deletedNodeIds = Array.from(new Set(
    events
      .filter((event) => event.type === 'message_deleted' && event.entityId)
      .map((event) => event.entityId)
  ));
  if (!deletedNodeIds.length) return;

  queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) });
};

const repairFromBootstrap = async (queryClient: QueryClient, workspaceId: string, cursorByWorkspace?: Record<string, number>) => {
  const response = await api.get<GraphBootstrapResponse>(`/workspaces/${workspaceId}/graph-bootstrap`);
  const bootstrap = response.data;
  if (!bootstrap?.graphSnapshot) return;
  queryClient.setQueryData(['graph-snapshot', workspaceId], bootstrap.graphSnapshot);
  void queryClient.invalidateQueries({ queryKey: ['messages', workspaceId] });
  if (Array.isArray(bootstrap.branchPointers)) {
    queryClient.setQueryData(branchKeys.workspace(workspaceId), bootstrap.branchPointers);
  }
  if (Array.isArray(bootstrap.trackedRefs)) {
    queryClient.setQueryData(trackedRefKeys.workspace(workspaceId), bootstrap.trackedRefs);
  }
  const nextCursor = Number(bootstrap.messageCursor ?? 0);
  if (cursorByWorkspace) {
    cursorByWorkspace[workspaceId] = nextCursor;
  }
  seededCursorByWorkspace.set(workspaceId, nextCursor);
  recordPerfEvent('query.message-deltas.bootstrap-repair', {
    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
    workspaceId,
    messageCursor: bootstrap.messageCursor ?? 0,
  }, { source: 'useHotSendMessageDeltas' });
};

const applyWorkspaceMessageDeltas = async (
  queryClient: QueryClient,
  workspaceId: string,
  cursorByWorkspace: Record<string, number>,
  options: { source: string }
) => {
  let sinceCursor = cursorByWorkspace[workspaceId];
  if (sinceCursor == null && seededCursorByWorkspace.has(workspaceId)) {
    sinceCursor = seededCursorByWorkspace.get(workspaceId) ?? 0;
    cursorByWorkspace[workspaceId] = sinceCursor;
  }
  if (sinceCursor == null) {
    await repairFromBootstrap(queryClient, workspaceId, cursorByWorkspace);
    return;
  }

  const startedAt = performance.now();
  const response = await api.get<MessageDeltaResponse>(`/workspaces/${workspaceId}/message-deltas`, {
    params: { sinceCursor, limit: 200 },
  });
  const payload = response.data;
  const events = Array.isArray(payload?.events) ? payload.events : [];
  recordPerfEvent('query.message-deltas.fetch', {
    elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
    workspaceId,
    sinceCursor,
    nextCursor: payload?.nextCursor ?? sinceCursor,
    eventCount: events.length,
    hasMore: Boolean(payload?.hasMore),
  }, {
    source: options.source,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  });

  const currentMessages = queryClient.getQueryData<Message[]>(['messages', workspaceId]);
  invalidateLocalNodesForDeletedEvents(queryClient, workspaceId, events);
  if (shouldRepairFromEvents(events, currentMessages)) {
    await repairFromBootstrap(queryClient, workspaceId, cursorByWorkspace);
  } else if (events.length > 0) {
    const fullMessages = events
      .filter((event) => event.type !== 'message_deleted' && event.message?.payload_kind === 'full_message')
      .map((event) => event.message)
      .filter((message): message is MessageDeltaPayload => Boolean(message));
    if (fullMessages.length > 0) {
      await agentClient.hydrateLocalNodesFromServer(workspaceId, fullMessages);
      queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(workspaceId) });
      queryClient.setQueryData<Message[]>(
        ['messages', workspaceId],
        (current) => applyLocalNodeMessages(current ?? [], fullMessages.map((message) => ({
          nodeId: message.id,
          workspaceId,
          syncStatus: 'persisted' as const,
          finalizedAt: Math.floor(Date.now() / 1000),
          retryAttempt: 0,
          message,
        })), workspaceId)
      );
    }
    queryClient.setQueryData<GraphSnapshot | undefined>(
      ['graph-snapshot', workspaceId],
      (current) => {
        const next = applyMessageEventsToGraphSnapshot(current, events);
        return next ? { ...next, cacheWriteDisabled: true } : next;
      }
    );
    cursorByWorkspace[workspaceId] = Number(payload?.nextCursor ?? sinceCursor);
    seededCursorByWorkspace.set(workspaceId, cursorByWorkspace[workspaceId]);
  }

  if (payload?.hasMore) {
    await applyWorkspaceMessageDeltas(queryClient, workspaceId, cursorByWorkspace, options);
  }
};

export const catchUpHotSendMessageDeltas = async (queryClient: QueryClient, workspaceId: string | null | undefined) => {
  if (!workspaceId || catchupInFlightByWorkspace.has(workspaceId)) return;
  if (agentClient.hasRuntime()) {
    recordPerfEvent('query.message-deltas.catchup-skipped', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      reason: 'local-runtime-authoritative',
    }, { source: 'useHotSendMessageDeltas.catchup' });
    return;
  }
  catchupInFlightByWorkspace.add(workspaceId);
  try {
    const cursorByWorkspace: Record<string, number> = {};
    await applyWorkspaceMessageDeltas(queryClient, workspaceId, cursorByWorkspace, {
      source: 'useHotSendMessageDeltas.catchup',
    });
  } catch (error) {
    recordPerfEvent('query.message-deltas.catchup-failed', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    }, { source: 'useHotSendMessageDeltas.catchup' });
    try {
      await repairFromBootstrap(queryClient, workspaceId);
    } catch (repairError) {
      recordPerfEvent('query.message-deltas.bootstrap-repair-failed', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        error: repairError instanceof Error ? repairError.message : String(repairError),
      }, { source: 'useHotSendMessageDeltas.catchup' });
    }
  } finally {
    catchupInFlightByWorkspace.delete(workspaceId);
  }
};

export const useHotSendMessageDeltas = (workspaceId: string | null) => {
  const queryClient = useQueryClient();
  const hasHotSendActivity = useRunStatusStore((state) => state.hasHotSendActivity(workspaceId, TERMINAL_GRACE_MS));
  const activeRunCount = useRunStatusStore((state) => state.getRunningCount(workspaceId));
  const cursorByWorkspaceRef = useRef<Record<string, number>>({});
  const pollingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const [seedNonce, setSeedNonce] = useState(0);

  useEffect(() => {
    const listener = (changedWorkspaceId: string) => {
      if (changedWorkspaceId !== workspaceId) return;
      setSeedNonce((value) => value + 1);
    };
    cursorSeedListeners.add(listener);
    return () => {
      cursorSeedListeners.delete(listener);
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    if (agentClient.hasRuntime()) return;
    if (!hasHotSendActivity) return;
    if (activeRunCount > 0) {
      recordPerfEvent('query.message-deltas.poll-paused', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId,
        activeRunCount,
        reason: 'active-tauri-stream',
      }, { source: 'useHotSendMessageDeltas' });
      return;
    }

    if (cursorByWorkspaceRef.current[workspaceId] == null && seededCursorByWorkspace.has(workspaceId)) {
      cursorByWorkspaceRef.current[workspaceId] = seededCursorByWorkspace.get(workspaceId) ?? 0;
    }
    if (cursorByWorkspaceRef.current[workspaceId] == null) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      if (cancelled || !workspaceId || pollingRef.current) return;
      if (!useRunStatusStore.getState().hasHotSendActivity(workspaceId, TERMINAL_GRACE_MS)) {
        recordPerfEvent('query.message-deltas.poll-stopped', {
          elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
          workspaceId,
          reason: 'no-hot-send-activity',
        }, { source: 'useHotSendMessageDeltas' });
        return;
      }
      pollingRef.current = true;
      try {
        await applyWorkspaceMessageDeltas(queryClient, workspaceId, cursorByWorkspaceRef.current, {
          source: 'useHotSendMessageDeltas',
        });
      } catch (error) {
        recordPerfEvent('query.message-deltas.fetch-failed', {
          elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        }, { source: 'useHotSendMessageDeltas' });
        try {
          await repairFromBootstrap(queryClient, workspaceId, cursorByWorkspaceRef.current);
        } catch (repairError) {
          recordPerfEvent('query.message-deltas.bootstrap-repair-failed', {
            elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
            workspaceId,
            error: repairError instanceof Error ? repairError.message : String(repairError),
          }, { source: 'useHotSendMessageDeltas' });
        }
      } finally {
        pollingRef.current = false;
        if (!cancelled && useRunStatusStore.getState().hasHotSendActivity(workspaceId, TERMINAL_GRACE_MS)) {
          timerRef.current = window.setTimeout(() => void poll(), POLL_MS);
        } else if (!cancelled) {
          recordPerfEvent('query.message-deltas.poll-stopped', {
            elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
            workspaceId,
            reason: 'no-hot-send-activity',
          }, { source: 'useHotSendMessageDeltas' });
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [activeRunCount, hasHotSendActivity, queryClient, seedNonce, workspaceId]);
};

export const primeHotSendMessageDeltaCursor = (workspaceId: string, cursor: number | null | undefined) => {
  if (!workspaceId) return;
  const nextCursor = Number(cursor);
  if (!Number.isFinite(nextCursor) || nextCursor < 0) return;
  seededCursorByWorkspace.set(workspaceId, nextCursor);
  for (const listener of cursorSeedListeners) {
    listener(workspaceId);
  }
};
