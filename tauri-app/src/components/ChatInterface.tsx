import { Profiler, useRef, useMemo, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { ChatInput } from './ChatInput';
import { useWorkspaceStore, Message, Summary } from '../stores/workspaceStore';
import { ScrollArea } from '../../@/components/ui/scroll-area';

import { useMessages, useSummaries, useDeleteMessageBranch } from '../hooks/useMessages';
import { useGraphSnapshot, graphSnapshotToSummaries } from '../hooks/useGraphSnapshot';
import { useScopes } from '../hooks/useScopes';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useWorkspaceProjection } from '../hooks/useWorkspaceProjection';
import { useWorkspaceMessages } from '../hooks/useLiveMessages';
import { useLocalNodes } from '../hooks/useLocalNodes';
import { useBranches } from '../hooks/useBranches';
import { useShallow } from 'zustand/react/shallow';
import { useIntegrationStore } from '../stores/integrationStore';
import { useRunStatusStore } from '../stores/runStatusStore';
import { useToastHelpers } from './Toast';
import { agentClient } from '../lib/agentClient';

import { ChatNodeDispatcher } from './nodes/chat/ChatNodeDispatcher';
import { ChatTurnGroupLayout } from './nodes/chat/ChatTurnGroupLayout';
import { ChatBreadcrumbRail } from './chat/ChatBreadcrumbRail';
import { ScopedNodeContextMenu, type ScopedContextMenuState } from './ScopedNodeContextMenu';
import { AddCommitDialog } from './AddCommitDialog';
import { DeleteBranchDialog, type DeleteBranchDialogPhase } from './DeleteBranchDialog';
import React from 'react';
import { createProfilerOnRender, startFocusInteraction } from '../lib/interactionProfiler';
import { getElapsedSinceAppStartMs, recordPerfEvent } from '../lib/perfRecorder';
import { recordFundamentalCounter } from '../perf/fundamentalCounters';
import { getDeleteBranchPreview, getTopLevelDeleteBranchIds } from '../domain/deleteBranchPreview';
import { getBranchPointerCommitSha, getMessageOutputCommitSha } from '../lib/graph/commitAccessors';

const getEntitySelectionId = (projection: any, entityId?: string): string | null => {
  if (!entityId) return null;
  const entity = projection.entitiesById.get(entityId);
  return entity?.messageId || entity?.summary?.id || null;
};

const chatProfilerOnRender = createProfilerOnRender('chat-surface');
const BOTTOM_PIN_THRESHOLD_PX = 96;
const USER_SCROLL_INTENT_WINDOW_MS = 1200;
const USER_SCROLL_POSITION_CAPTURE_WINDOW_MS = 100;

const isViewportNearBottom = (viewport: HTMLDivElement): boolean => (
  viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_PIN_THRESHOLD_PX
);

const TERMINAL_CHAT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'error']);

const shouldRefreshHeldChatMessage = (held: Message, incoming: Message): boolean => {
  const heldStatus = typeof held.status === 'string' ? held.status : null;
  const incomingStatus = typeof incoming.status === 'string' ? incoming.status : null;
  if (
    TERMINAL_CHAT_STATUSES.has(heldStatus || '') &&
    !TERMINAL_CHAT_STATUSES.has(incomingStatus || '')
  ) {
    return false;
  }
  if (heldStatus !== incomingStatus) return true;

  const heldContentLength = held.content?.length ?? 0;
  const incomingContentLength = incoming.content?.length ?? 0;
  if (incomingContentLength > heldContentLength) return true;
  if (TERMINAL_CHAT_STATUSES.has(incomingStatus || '') && incomingContentLength !== heldContentLength) return true;

  const heldExecution = (held.execution_data ?? {}) as Record<string, any>;
  const incomingExecution = (incoming.execution_data ?? {}) as Record<string, any>;
  if (heldExecution.last_terminal_status !== incomingExecution.last_terminal_status) return true;
  if (heldExecution.last_agent_event_seq !== incomingExecution.last_agent_event_seq) return true;
  if (heldExecution.last_stream_seq !== incomingExecution.last_stream_seq) return true;

  if (held.promptTokens !== incoming.promptTokens) return true;
  if (held.completionTokens !== incoming.completionTokens) return true;
  if (held.totalTokens !== incoming.totalTokens) return true;

  return false;
};

export function ChatInterface() {
  const {
    selectedWorkspaceId,
    focusedMessageId,
    focusNonce,
    lastFocusSource,
    lastFocusMetadata,
    lastFocusedMessageByWorkspace,
    activeSendFlowFocus,
    selectedMessageIds,
    dispatchFocus,
    replaceSelectedMessageIds,
    toggleSelectedMessageId,
    clearSelectedMessageIds,
    disabledSummaryIds,
  } = useWorkspaceStore(
    useShallow((state) => ({
      selectedWorkspaceId: state.selectedWorkspaceId,
      focusedMessageId: state.focusedMessageId,
      focusNonce: state.focusNonce,
      lastFocusSource: state.lastFocusSource,
      lastFocusMetadata: state.lastFocusMetadata,
      lastFocusedMessageByWorkspace: state.lastFocusedMessageByWorkspace,
      activeSendFlowFocus: state.activeSendFlowFocus,
      selectedMessageIds: state.selectedMessageIds,
      dispatchFocus: state.dispatchFocus,
      replaceSelectedMessageIds: state.replaceSelectedMessageIds,
      toggleSelectedMessageId: state.toggleSelectedMessageId,
      clearSelectedMessageIds: state.clearSelectedMessageIds,
      disabledSummaryIds: state.disabledSummaryIds,
    }))
  );

  const graphSnapshotQuery = useGraphSnapshot(selectedWorkspaceId || null);
  const shouldHydrateFullMessages = graphSnapshotQuery.isSuccess || graphSnapshotQuery.isError;
  const messagesQuery = useMessages(selectedWorkspaceId);
  const localNodesQuery = useLocalNodes(selectedWorkspaceId);
  const summariesQuery = useSummaries(selectedWorkspaceId, { enabled: shouldHydrateFullMessages && !agentClient.hasRuntime() });
  const scopesQuery = useScopes(selectedWorkspaceId);
  const { data: branchPointersData } = useBranches(selectedWorkspaceId || null);
  const { data: workspacesData } = useWorkspaces();
  const runningCount = useRunStatusStore((state) => state.getRunningCount(selectedWorkspaceId));
  const deleteMessageBranchMutation = useDeleteMessageBranch();
  const { openMergeSession } = useIntegrationStore();
  const toast = useToastHelpers();

  const snapshotSummaries = useMemo(() => graphSnapshotToSummaries(graphSnapshotQuery.data), [graphSnapshotQuery.data]);
  const persistedMessages = useMemo(() => (messagesQuery.data ?? []) as Message[], [messagesQuery.data]);
  const messages = useWorkspaceMessages(selectedWorkspaceId, persistedMessages, localNodesQuery.data);
  const branchPointers = useMemo(() => branchPointersData ?? [], [branchPointersData]);
  const summaries = useMemo(() => (summariesQuery.data ?? snapshotSummaries) as Summary[], [snapshotSummaries, summariesQuery.data]);

  const branchPointersByNodeId = useMemo(() => {
    const map = new Map<string, typeof branchPointers>();
    const pointersByCommit = new Map<string, typeof branchPointers>();

    for (const pointer of branchPointers) {
      const commitSha = getBranchPointerCommitSha(pointer);
      if (commitSha) {
        const commitList = pointersByCommit.get(commitSha) ?? [];
        commitList.push(pointer);
        pointersByCommit.set(commitSha, commitList);
      }
    }

    for (const message of messages) {
      const commitSha = getMessageOutputCommitSha(message);
      if (!commitSha) continue;
      const commitPointers = pointersByCommit.get(commitSha);
      if (!commitPointers || commitPointers.length === 0) continue;
      map.set(message.id, commitPointers);
    }

    return map;
  }, [branchPointers, messages]);

  const enrichedMessages = useMemo(() => (
    messages.map((message) => {
      const resolvedPointers = branchPointersByNodeId.get(message.id) ?? [];
      const currentPointers = message.branchPointers ?? [];
      if (currentPointers === resolvedPointers) return message;
      if (currentPointers.length === resolvedPointers.length && currentPointers.every((pointer, index) => pointer.id === resolvedPointers[index]?.id)) {
        return message;
      }
      return {
        ...message,
        branchPointers: resolvedPointers,
      };
    })
  ), [branchPointersByNodeId, messages]);
  const activeSendFlowInWorkspace = activeSendFlowFocus?.workspaceId === selectedWorkspaceId;
  const isDirectFocusSource = lastFocusSource === 'graph' || lastFocusSource === 'chat' || lastFocusSource === 'timeline';
  const activeSendProjectionFocusId = activeSendFlowInWorkspace && !isDirectFocusSource
    ? activeSendFlowFocus.preferredMessageId
    : null;
  const projectionFocusMessageId = activeSendProjectionFocusId ?? focusedMessageId;
  const activeChatProjectionHold = runningCount > 0 || activeSendFlowInWorkspace;
  const chatProjectionMessagesRef = useRef<Message[]>(enrichedMessages);
  const chatProjectionMessages = useMemo(() => {
    const current = chatProjectionMessagesRef.current;
    if (!activeChatProjectionHold) {
      chatProjectionMessagesRef.current = enrichedMessages;
      recordFundamentalCounter('chat.projection-messages', {
        mode: 'live',
        messageCount: enrichedMessages.length,
        runningCount,
        activeSendFlow: activeSendFlowInWorkspace,
      });
      return enrichedMessages;
    }

    const focusedMessageMissing = Boolean(
      projectionFocusMessageId &&
      !current.some((message) => message.id === projectionFocusMessageId)
    );
    if (!current || current.length === 0 || enrichedMessages.length !== current.length || focusedMessageMissing) {
      chatProjectionMessagesRef.current = enrichedMessages;
      recordFundamentalCounter('chat.projection-messages', {
        mode: 'active-refresh',
        messageCount: enrichedMessages.length,
        previousMessageCount: current?.length ?? 0,
        focusedMessageMissing,
        runningCount,
        activeSendFlow: activeSendFlowInWorkspace,
      });
      return enrichedMessages;
    }

    const incomingById = new Map(enrichedMessages.map((message) => [message.id, message]));
    let refreshedCount = 0;
    const mergedCurrent = current.map((message) => {
      const incoming = incomingById.get(message.id);
      if (!incoming || !shouldRefreshHeldChatMessage(message, incoming)) return message;
      refreshedCount += 1;
      return incoming;
    });

    if (refreshedCount > 0) {
      chatProjectionMessagesRef.current = mergedCurrent;
      recordFundamentalCounter('chat.projection-messages', {
        mode: 'active-merged',
        messageCount: mergedCurrent.length,
        incomingMessageCount: enrichedMessages.length,
        refreshedCount,
        runningCount,
        activeSendFlow: activeSendFlowInWorkspace,
      });
      return mergedCurrent;
    }

    recordFundamentalCounter('chat.projection-messages', {
      mode: 'active-held',
      messageCount: current.length,
      incomingMessageCount: enrichedMessages.length,
      runningCount,
      activeSendFlow: activeSendFlowInWorkspace,
    });
    return current;
  }, [activeChatProjectionHold, activeSendFlowInWorkspace, enrichedMessages, projectionFocusMessageId, runningCount]);

  const scopes = useMemo(() => (scopesQuery.data?.scopes ?? []), [scopesQuery.data?.scopes]);
  const disabledSummaryIdsSet = useMemo(() => new Set(disabledSummaryIds), [disabledSummaryIds]);
  const projection = useWorkspaceProjection(chatProjectionMessages, scopes, summaries, projectionFocusMessageId, disabledSummaryIdsSet, 'chat');

  const viewportRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const userScrollIntentUntilRef = useRef(0);
  const userScrollPositionCaptureUntilRef = useRef(0);
  const lastUserScrollTopRef = useRef<number | null>(null);
  const stickyBottomRafRef = useRef<number | null>(null);
  const lastViewportScrollTopRef = useRef<number | null>(null);
  const activeScrollFlowIdRef = useRef<string | null>(null);
  const chatDataReadyLoggedRef = useRef<string | null>(null);
  const chatContentRenderedLoggedRef = useRef<string | null>(null);

  const [contextMenu, setContextMenu] = useState<ScopedContextMenuState | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const [deletePhase, setDeletePhase] = useState<DeleteBranchDialogPhase>('idle');
  const pendingDeletePreview = useMemo(
    () => getDeleteBranchPreview(pendingDeleteIds, projection.messageMap),
    [pendingDeleteIds, projection.messageMap]
  );
  const [addCommitTargetId, setAddCommitTargetId] = useState<string | null>(null);
  const selectedMessageIdsSet = useMemo(() => new Set(selectedMessageIds), [selectedMessageIds]);
	  const selectedWorkspace = useMemo(() => {
    if (!workspacesData || !selectedWorkspaceId) return null;
    return workspacesData.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;
  }, [workspacesData, selectedWorkspaceId]);
  const selectedRepoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath || null;

		  useEffect(() => {
	    if (!selectedWorkspaceId || persistedMessages.length === 0) return;
      if (activeSendFlowFocus?.workspaceId === selectedWorkspaceId) return;

	    const renderedMessageIds = new Set(messages.map((message) => message.id));
	    if (focusedMessageId && renderedMessageIds.has(focusedMessageId)) return;
      const focusedCommitSha = typeof lastFocusMetadata?.commitSha === 'string'
        ? lastFocusMetadata.commitSha.trim()
        : '';
      if (lastFocusSource === 'graph' && focusedCommitSha && focusedMessageId === focusedCommitSha) return;

	    const persistedMessageIds = new Set(persistedMessages.map((message) => message.id));
	    const rememberedFocusId = lastFocusedMessageByWorkspace[selectedWorkspaceId] ?? null;
	    const fallbackMessage = rememberedFocusId && persistedMessageIds.has(rememberedFocusId)
	      ? persistedMessages.find((message) => message.id === rememberedFocusId)
	      : [...persistedMessages].sort((a, b) => {
	          const aTime = new Date(a.updatedAt || a.createdAt).getTime();
	          const bTime = new Date(b.updatedAt || b.createdAt).getTime();
	          return bTime - aTime;
	        })[0];

	    if (!fallbackMessage || fallbackMessage.id === focusedMessageId) return;
	    dispatchFocus({
	      messageId: fallbackMessage.id,
	      source: 'system',
	      metadata: {
	        reason: rememberedFocusId === fallbackMessage.id ? 'restore-workspace-focus' : 'default-workspace-focus',
	      },
	    });
	  }, [
	    dispatchFocus,
	    focusedMessageId,
      lastFocusMetadata,
      lastFocusSource,
	    lastFocusedMessageByWorkspace,
      activeSendFlowFocus,
	    messages,
	    persistedMessages,
	    selectedWorkspaceId,
	  ]);

  useEffect(() => {
    if (!selectedWorkspaceId || persistedMessages.length === 0) return;
    if (chatDataReadyLoggedRef.current === selectedWorkspaceId) return;

    chatDataReadyLoggedRef.current = selectedWorkspaceId;
    recordPerfEvent('chat.data-ready', {
      elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
      workspaceId: selectedWorkspaceId,
      persistedMessageCount: persistedMessages.length,
      liveMessageCount: messages.length,
      summaryCount: summaries.length,
      scopeCount: scopes.length,
      queryStatus: messagesQuery.status,
      usingSnapshot: false,
    }, { source: 'ChatInterface' });
  }, [
    messages.length,
    messagesQuery.data,
    messagesQuery.status,
    persistedMessages.length,
    scopes.length,
    selectedWorkspaceId,
    summaries.length,
  ]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      chatDataReadyLoggedRef.current = null;
      chatContentRenderedLoggedRef.current = null;
      return;
    }
    if (projection.chatItems.length === 0) return;
    if (chatContentRenderedLoggedRef.current === selectedWorkspaceId) return;

    const rafId = window.requestAnimationFrame(() => {
      if (chatContentRenderedLoggedRef.current === selectedWorkspaceId) return;
      chatContentRenderedLoggedRef.current = selectedWorkspaceId;
      recordPerfEvent('chat.first-content-render', {
        elapsedSinceAppStartMs: getElapsedSinceAppStartMs(),
        workspaceId: selectedWorkspaceId,
        chatItemCount: projection.chatItems.length,
        messageCount: messages.length,
      }, { source: 'ChatInterface' });
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [messages.length, projection.chatItems.length, selectedWorkspaceId]);

	  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !focusedMessageId) return;
    recordFundamentalCounter('chat.focus-scroll.effect', {
      focusedMessageId,
      lastFocusSource,
      chatItemCount: projection.chatItems.length,
      activeSendFlow: Boolean(activeSendFlowFocus),
      focusNonce,
    });

    let rafId: number | null = null;
    let endRafId: number | null = null;
    let endTimeoutId: number | null = null;
    let endRecorded = false;
    const graphRecenterDuration = typeof lastFocusMetadata?.recenterAnimationDurationMs === 'number'
      ? lastFocusMetadata.recenterAnimationDurationMs
      : null;
    const flowId = typeof lastFocusMetadata?.flowId === 'string' ? lastFocusMetadata.flowId : null;
    const focusPhase = typeof lastFocusMetadata?.phase === 'string' ? lastFocusMetadata.phase : null;
    const isComposerSendFocus = lastFocusSource === 'composer' || Boolean(flowId);
    const isDirectSelectionFocus = lastFocusSource === 'graph' || lastFocusSource === 'chat' || lastFocusSource === 'timeline';
    const scrollBehavior: ScrollBehavior = isComposerSendFocus || lastFocusSource === 'graph' ? 'auto' : 'smooth';
    const scrollDelayMs = 0;
    const isNewComposerFlow = isComposerSendFocus && !!flowId && activeScrollFlowIdRef.current !== flowId;

    if (isNewComposerFlow && flowId) {
      activeScrollFlowIdRef.current = flowId;
      shouldStickToBottomRef.current = true;
    }

    if (isDirectSelectionFocus) {
      shouldStickToBottomRef.current = false;
    }

    recordPerfEvent('chat.focus-scroll.scheduled', {
      focusedMessageId,
      source: lastFocusSource,
      flowId,
      focusPhase,
      delayMs: scrollDelayMs,
      recenterAnimationDurationMs: graphRecenterDuration,
      chatItemCount: projection.chatItems.length,
      focusNonce,
    }, { source: 'ChatInterface' });

    const recordScrollEnd = (
      scrollStartedAt: number,
      targetFound: boolean,
      reason: 'target' | 'bottom' | 'sticky-bottom',
    ) => {
      if (endRecorded) return;
      endRecorded = true;
      recordPerfEvent('chat.focus-scroll.end', {
        focusedMessageId,
        source: lastFocusSource,
        flowId,
        focusPhase,
        targetFound,
        reason,
        focusNonce,
      }, {
        source: 'ChatInterface',
        durationMs: Number((performance.now() - scrollStartedAt).toFixed(2)),
      });
    };

    const scheduleScrollEnd = (
      scrollStartedAt: number,
      targetFound: boolean,
      reason: 'target' | 'bottom' | 'sticky-bottom',
    ) => {
      endRafId = window.requestAnimationFrame(() => recordScrollEnd(scrollStartedAt, targetFound, reason));
      endTimeoutId = window.setTimeout(() => recordScrollEnd(scrollStartedAt, targetFound, reason), 250);
    };

    const runScroll = () => {
      const scrollStartedAt = performance.now();
      const focusSelector = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? `[data-chat-focus-id="${CSS.escape(focusedMessageId)}"]`
        : `[data-chat-focus-id="${focusedMessageId.replace(/"/g, '\\"')}"]`;
      const target = viewport.querySelector<HTMLElement>(focusSelector);
      if (target && isDirectSelectionFocus) {
        recordPerfEvent('chat.focus-scroll.start', {
          focusedMessageId,
          source: lastFocusSource,
          flowId,
          focusPhase,
          targetFound: true,
          reason: 'target',
          chatItemCount: projection.chatItems.length,
          focusNonce,
        }, { source: 'ChatInterface' });
        target.scrollIntoView({ behavior: scrollBehavior, block: 'end' });
        scheduleScrollEnd(scrollStartedAt, true, 'target');
        return;
      }

      if (shouldStickToBottomRef.current) {
        recordPerfEvent('chat.focus-scroll.start', {
          focusedMessageId,
          source: lastFocusSource,
          flowId,
          focusPhase,
          targetFound: Boolean(target),
          reason: 'sticky-bottom',
          chatItemCount: projection.chatItems.length,
          focusNonce,
        }, { source: 'ChatInterface' });
        if (isComposerSendFocus) {
          viewport.scrollTop = viewport.scrollHeight;
        } else {
          viewport.scrollTo({
            top: viewport.scrollHeight,
            behavior: scrollBehavior,
          });
        }
        scheduleScrollEnd(scrollStartedAt, Boolean(target), 'sticky-bottom');
        return;
      }

      if (isComposerSendFocus) {
        recordPerfEvent('chat.focus-scroll.skipped', {
          focusedMessageId,
          source: lastFocusSource,
          flowId,
          focusPhase,
          targetFound: Boolean(target),
          reason: 'user-scroll-intent',
          chatItemCount: projection.chatItems.length,
          focusNonce,
        }, { source: 'ChatInterface' });
        return;
      }

      recordPerfEvent('chat.focus-scroll.start', {
        focusedMessageId,
        source: lastFocusSource,
        flowId,
        focusPhase,
        targetFound: Boolean(target),
        chatItemCount: projection.chatItems.length,
        focusNonce,
      }, { source: 'ChatInterface' });
      if (target) {
        target.scrollIntoView({ behavior: scrollBehavior, block: 'end' });
        scheduleScrollEnd(scrollStartedAt, true, 'target');
        return;
      }
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: scrollBehavior,
      });
      scheduleScrollEnd(scrollStartedAt, false, 'bottom');
    };

    const scheduleScroll = () => {
      rafId = window.requestAnimationFrame(() => runScroll());
    };

    scheduleScroll();

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      if (endTimeoutId !== null) window.clearTimeout(endTimeoutId);
      if (endRafId !== null) window.cancelAnimationFrame(endRafId);
    };
  }, [focusedMessageId, focusNonce, lastFocusMetadata, lastFocusSource]);

  const chatScrollAnchorFingerprint = useMemo(() => (
    messages.map((message) => [
      message.id,
      message.status || '',
      message.updatedAt || '',
      typeof message.content === 'string' ? message.content.length : 0,
      typeof message.reasoning === 'string' ? message.reasoning.length : 0,
    ].join(':')).join('|')
  ), [messages]);

  const markUserScrollIntent = useCallback(() => {
    const now = performance.now();
    userScrollIntentUntilRef.current = now + USER_SCROLL_INTENT_WINDOW_MS;
    userScrollPositionCaptureUntilRef.current = now + USER_SCROLL_POSITION_CAPTURE_WINDOW_MS;
  }, []);

  const restoreUserScrollPosition = useCallback((reason: 'scroll-event' | 'layout-effect') => {
    const viewport = viewportRef.current;
    if (!viewport || shouldStickToBottomRef.current) return;
    const expectedScrollTop = lastUserScrollTopRef.current;
    if (expectedScrollTop === null || Math.abs(viewport.scrollTop - expectedScrollTop) <= 24) return;
    const nextTop = Math.max(
      0,
      Math.min(expectedScrollTop, viewport.scrollHeight - viewport.clientHeight),
    );
    const previousScrollTop = viewport.scrollTop;
    viewport.scrollTop = nextTop;
    recordPerfEvent('chat.user-scroll.restored', {
      reason,
      expectedScrollTop: Math.round(expectedScrollTop),
      restoredScrollTop: Math.round(nextTop),
      previousScrollTop: Math.round(previousScrollTop),
      scrollHeight: Math.round(viewport.scrollHeight),
      clientHeight: Math.round(viewport.clientHeight),
      activeSendFlow: activeSendFlowInWorkspace,
      runningCount,
    }, { source: 'ChatInterface' });
  }, [activeSendFlowInWorkspace, runningCount]);

  const handleViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    lastViewportScrollTopRef.current = viewport.scrollTop;
    const now = performance.now();
    const hasUserScrollIntent = now <= userScrollIntentUntilRef.current;
    const shouldCaptureUserScrollPosition = now <= userScrollPositionCaptureUntilRef.current;

    if (isViewportNearBottom(viewport)) {
      shouldStickToBottomRef.current = true;
      lastUserScrollTopRef.current = null;
      return;
    }

    if (hasUserScrollIntent) {
      shouldStickToBottomRef.current = false;
      if (shouldCaptureUserScrollPosition) {
        lastUserScrollTopRef.current = viewport.scrollTop;
        recordPerfEvent('chat.user-scroll-intent', {
          scrollTop: Math.round(viewport.scrollTop),
          scrollHeight: Math.round(viewport.scrollHeight),
          clientHeight: Math.round(viewport.clientHeight),
          activeSendFlow: activeSendFlowInWorkspace,
          runningCount,
        }, { source: 'ChatInterface' });
        return;
      }
    }

    restoreUserScrollPosition('scroll-event');
  }, [restoreUserScrollPosition]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.addEventListener('wheel', markUserScrollIntent, { passive: true });
    viewport.addEventListener('touchstart', markUserScrollIntent, { passive: true });
    viewport.addEventListener('pointerdown', markUserScrollIntent);
    viewport.addEventListener('pointermove', markUserScrollIntent);
    viewport.addEventListener('keydown', markUserScrollIntent);

    return () => {
      viewport.removeEventListener('wheel', markUserScrollIntent);
      viewport.removeEventListener('touchstart', markUserScrollIntent);
      viewport.removeEventListener('pointerdown', markUserScrollIntent);
      viewport.removeEventListener('pointermove', markUserScrollIntent);
      viewport.removeEventListener('keydown', markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    userScrollIntentUntilRef.current = 0;
    userScrollPositionCaptureUntilRef.current = 0;
    lastUserScrollTopRef.current = null;
    lastViewportScrollTopRef.current = null;
    activeScrollFlowIdRef.current = null;
  }, [selectedWorkspaceId]);

  useLayoutEffect(() => {
    restoreUserScrollPosition('layout-effect');
  }, [chatScrollAnchorFingerprint, projection.chatItems.length, restoreUserScrollPosition]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !shouldStickToBottomRef.current) return;
    const startedAt = performance.now();
    const deferScroll = runningCount > 0 || activeSendFlowInWorkspace;

    const scrollToBottom = () => {
      if (!shouldStickToBottomRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    };

    if (stickyBottomRafRef.current !== null) {
      window.cancelAnimationFrame(stickyBottomRafRef.current);
      stickyBottomRafRef.current = null;
    }

    if (!deferScroll) {
      scrollToBottom();
    }
    recordFundamentalCounter('chat.sticky-bottom.layout-effect', {
      messageCount: messages.length,
      chatItemCount: projection.chatItems.length,
      focusedMessageId,
      activeSendFlow: activeSendFlowInWorkspace,
      deferred: deferScroll,
    }, performance.now() - startedAt);
    stickyBottomRafRef.current = window.requestAnimationFrame(() => {
      stickyBottomRafRef.current = null;
      scrollToBottom();
    });
    return () => {
      if (stickyBottomRafRef.current !== null) {
        window.cancelAnimationFrame(stickyBottomRafRef.current);
        stickyBottomRafRef.current = null;
      }
    };
  }, [activeSendFlowInWorkspace, chatScrollAnchorFingerprint, focusedMessageId, messages.length, projection.chatItems.length, runningCount, selectedWorkspaceId]);

  const handleFocus = useCallback((id: string, metadata?: Record<string, unknown>) => {
    if (id === focusedMessageId) return;

    const message = enrichedMessages.find((candidate) => candidate.id === id) ?? null;
    startFocusInteraction({
      source: message?.role === 'assistant'
        ? 'chat.assistant-message'
        : message?.role === 'user'
          ? 'chat.user-message'
          : 'unknown',
      targetId: id,
      targetType: message?.role === 'assistant'
        ? 'assistant-message'
        : message?.role === 'user'
          ? 'user-message'
          : 'unknown',
    });
    clearSelectedMessageIds();
    dispatchFocus({ messageId: id, source: 'chat', metadata });
  }, [clearSelectedMessageIds, dispatchFocus, enrichedMessages, focusedMessageId]);

  const handleSelect = useCallback((id: string, multi: boolean) => {
    if (multi) {
      toggleSelectedMessageId(id);
      return;
    }
    replaceSelectedMessageIds([id]);
  }, [replaceSelectedMessageIds, toggleSelectedMessageId]);

  const handleContextMenu = useCallback((id: string, event: React.MouseEvent) => {
    const scopedIds = selectedMessageIdsSet.has(id) ? Array.from(selectedMessageIdsSet) : [id];
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      scopedIds,
    });
  }, [selectedMessageIdsSet]);

  const handleBackgroundClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    clearSelectedMessageIds();
    setContextMenu(null);
  }, [clearSelectedMessageIds]);

  const handleAddCommitsToMergePanel = useCallback((messageIds: string[]) => {
    if (!selectedWorkspaceId) return;

    const repoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath;
    if (!repoPath) {
      toast.error('No repository', 'This workspace has no git repository');
      return;
    }

    const integrationState = useIntegrationStore.getState();
    if (!integrationState.session || integrationState.session.workspaceId !== selectedWorkspaceId || integrationState.session.repoPath !== repoPath) {
      openMergeSession(selectedWorkspaceId, repoPath);
    }

    const { addSource } = useIntegrationStore.getState();
    const mergeableMessages = messageIds
      .map((id) => enrichedMessages.find((message) => message.id === id))
      .map((message) => ({ message, commitSha: getMessageOutputCommitSha(message) }))
      .filter((item): item is { message: Message; commitSha: string } => !!item.message && !!item.commitSha);

    let addedCount = 0;
    for (const { message, commitSha } of mergeableMessages) {
      const added = addSource({
        id: message.id,
        type: 'graph-node',
        label: message.aiLabel || message.content.slice(0, 50) || message.id.slice(0, 8),
        commitSha,
        nodeId: message.id,
      });
      if (added) addedCount += 1;
    }

    const duplicateCount = mergeableMessages.length - addedCount;
    if (addedCount > 0) {
      toast.success(
        'Added to merge panel',
        addedCount === 1 ? '1 commit added to merge sources.' : `${addedCount} commits added to merge sources.`
      );
    }
    if (duplicateCount > 0) {
      toast.info(
        'Already in merge panel',
        duplicateCount === 1 ? '1 commit was already present.' : `${duplicateCount} commits were already present.`
      );
    }
  }, [enrichedMessages, openMergeSession, selectedWorkspace, selectedWorkspaceId, toast]);

  const handleDeleteMessages = useCallback((messageIds: string[]) => {
    setPendingDeleteIds(getTopLevelDeleteBranchIds(messageIds, projection.messageMap));
    setDeletePhase('idle');
  }, [projection.messageMap]);

  const resetDeleteDialog = useCallback(() => {
    setPendingDeleteIds([]);
    setDeletePhase('idle');
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!selectedWorkspaceId || pendingDeleteIds.length === 0) {
      resetDeleteDialog();
      return;
    }

    setDeletePhase('deleting');
    try {
      for (const messageId of pendingDeleteIds) {
        await deleteMessageBranchMutation.mutateAsync({
          workspaceId: selectedWorkspaceId,
          messageId,
        });
      }
      toast.success(
        'Nodes deleted',
        pendingDeleteIds.length === 1 ? 'Deleted 1 node branch.' : `Deleted ${pendingDeleteIds.length} node branches.`
      );
      clearSelectedMessageIds();
      setDeletePhase('success');
      window.setTimeout(resetDeleteDialog, 750);
    } catch (error) {
      toast.error('Delete failed', error instanceof Error ? error.message : 'Could not delete selected nodes.');
      setDeletePhase('idle');
    }
  }, [clearSelectedMessageIds, deleteMessageBranchMutation, pendingDeleteIds, resetDeleteDialog, selectedWorkspaceId, toast]);

  if (!selectedWorkspaceId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
        <p>No workspace selected</p>
        <p className="text-sm">Use the workspace selector in the header to select a project</p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 h-full w-full max-w-full flex-col overflow-hidden bg-background text-foreground">
      <ChatBreadcrumbRail
        projection={projection}
        focusedMessageId={focusedMessageId}
        onFocus={handleFocus}
      />

      <ScrollArea
        className="flex-1 min-w-0 w-full max-w-full overflow-hidden bg-slate-50 dark:bg-slate-950"
        viewportRef={viewportRef}
        onViewportScroll={handleViewportScroll}
      >
        <Profiler id="ChatSurface" onRender={chatProfilerOnRender}>
          <div className="box-border min-w-0 w-full max-w-full overflow-x-hidden py-12 px-3" onClick={handleBackgroundClick}>
            {projection.chatItems
              .map((item, index) => {
              if (item.type === 'turn') {
                const turn = projection.turnGroupById.get(item.turnGroupId);
                if (!turn) return null;
                const isFocused = turn.memberEntityIds.some(eid => projection.entitiesById.get(eid)?.messageId === focusedMessageId);

                return (
                  <ChatTurnGroupLayout key={`turn:${item.turnGroupId}`} isFocused={isFocused}>
                    <ChatNodeDispatcher
                      entityId={turn.userEntityId}
                      projection={projection}
                      focusedMessageId={focusedMessageId}
                      isSelected={selectedMessageIdsSet.has(getEntitySelectionId(projection, turn.userEntityId) || '')}
                      onFocus={handleFocus}
                      onSelect={handleSelect}
                      onContextMenu={handleContextMenu}
                    />
                    {item.assistantEntityIds.map((aeid) => {
                      const commitEntityIds = item.commitEntityIdsByAssistantEntityId[aeid] || [];
                      return (
                        <React.Fragment key={aeid}>
                          <ChatNodeDispatcher
                            entityId={aeid}
                            projection={projection}
                            focusedMessageId={focusedMessageId}
                            isSelected={selectedMessageIdsSet.has(getEntitySelectionId(projection, aeid) || '')}
                            onFocus={handleFocus}
                            onSelect={handleSelect}
                            onContextMenu={handleContextMenu}
                          />
                          {commitEntityIds.map((ceid) => (
                            <div key={`commit:${ceid}`} className="min-w-0 w-full max-w-full">
                              <ChatNodeDispatcher
                                entityId={ceid}
                                projection={projection}
                                focusedMessageId={focusedMessageId}
                                isSelected={selectedMessageIdsSet.has(getEntitySelectionId(projection, ceid) || '')}
                                onFocus={handleFocus}
                                onSelect={handleSelect}
                                onContextMenu={handleContextMenu}
                              />
                            </div>
                          ))}
                        </React.Fragment>
                      );
                    })}
                  </ChatTurnGroupLayout>
                );
              }

              const id = (item as any).entityId || (item as any).turnGroupId || `${item.type}:${index}`;
              return (
                <div key={`${item.type}:${id}`} className="box-border min-w-0 w-full max-w-full px-3 py-3 md:px-6 md:py-4 mb-8 last:mb-0">
                  <ChatNodeDispatcher
                    entityId={(item as any).entityId || (item as any).userEntityId}
                    projection={projection}
                    focusedMessageId={focusedMessageId}
                    isSelected={selectedMessageIdsSet.has(getEntitySelectionId(projection, (item as any).entityId || (item as any).userEntityId) || '')}
                    onFocus={handleFocus}
                    onSelect={handleSelect}
                    onContextMenu={handleContextMenu}
                  />
                </div>
              );
              })}
          </div>
        </Profiler>
      </ScrollArea>

      <div className="relative z-[60] overflow-visible p-4 border-t bg-background">
        <ChatInput />
      </div>


      <ScopedNodeContextMenu
        contextMenu={contextMenu}
        projection={projection}
        onClose={() => setContextMenu(null)}
        onDeleteMessages={handleDeleteMessages}
        onAddCommitsToMergePanel={handleAddCommitsToMergePanel}
        onAddCommitToNode={setAddCommitTargetId}
      />
      <AddCommitDialog
        open={!!addCommitTargetId}
        workspaceId={selectedWorkspaceId}
        repoPath={selectedRepoPath}
        baseCommitSha={selectedWorkspace?.base_commit_sha ?? null}
        parentNodeId={addCommitTargetId}
        messages={enrichedMessages}
        onOpenChange={(open) => {
          if (!open) setAddCommitTargetId(null);
        }}
      />
      <DeleteBranchDialog
        open={pendingDeleteIds.length > 0}
        title="Delete selected node branches?"
        preview={pendingDeletePreview}
        phase={deletePhase}
        onOpenChange={(open) => {
          if (deletePhase === 'deleting' || deletePhase === 'success') return;
          if (!open) resetDeleteDialog();
        }}
        onCancel={resetDeleteDialog}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
