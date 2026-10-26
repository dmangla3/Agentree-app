import { isActiveAgentStatus } from '@shared/agentStatus';
import { agentClient } from '../lib/agentClient';
import { useAgentRunProjectionStore, type AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import type { Message } from '../stores/workspaceStore';
import { agentRunManager } from './agentRunManager';
import {
  ingestAgentRunStreamEvent,
  type AgentRunStreamIngestInput,
  type AgentRunStreamIngestState,
} from './agentRunHydration';

type StopSubscription = () => void;

type CoordinatorDeps = {
  getSelectedWorkspaceId: () => string | null;
  onLandingWarning?: (warning: {
    nodeId: string;
    message: string;
    outputCommitSha: string | null;
  }) => void;
};

const NATIVE_SUBSCRIPTION_RETRY_DELAY_MS = 1_000;
const MAX_NATIVE_SUBSCRIPTION_RETRIES = 3;

const trackedMessages = new Map<string, Message>();
const streamStates = new Map<string, AgentRunStreamIngestState>();

let activeCoordinatorCount = 0;
let nativeUnlisten: StopSubscription | null = null;
let nativeSubscriptionPromise: Promise<StopSubscription> | null = null;
let nativeSubscriptionRetryCount = 0;
let nativeSubscriptionRetryTimer: ReturnType<typeof setTimeout> | null = null;

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const cleanStatus = (value: unknown) => (
  typeof value === 'string' ? value : null
);

const getProjection = (nodeId: string): AgentRunProjectedMessage | null => (
  useAgentRunProjectionStore.getState().projectionsById[nodeId] ?? null
);

const getStreamState = (nodeId: string): AgentRunStreamIngestState => {
  const existing = streamStates.get(nodeId);
  if (existing) return existing;

  const snapshot = agentRunManager.snapshot(nodeId);
  const projection = getProjection(nodeId);
  const tracked = trackedMessages.get(nodeId);
  const state: AgentRunStreamIngestState = {
    output: snapshot?.content ?? projection?.content ?? tracked?.content ?? '',
    providerItemId: null,
  };
  streamStates.set(nodeId, state);
  return state;
};

const buildInput = (
  nodeId: string,
  event: Record<string, any>,
  deps: CoordinatorDeps,
): AgentRunStreamIngestInput => {
  const snapshot = agentRunManager.snapshot(nodeId);
  const projection = getProjection(nodeId);
  const tracked = trackedMessages.get(nodeId);
  const executionData = {
    ...((tracked?.execution_data ?? {}) as Record<string, any>),
    ...((projection?.execution_data ?? {}) as Record<string, any>),
    ...(snapshot?.executionData ?? {}),
  };
  const runId = cleanString(event.run_id)
    ?? cleanString((executionData as any).current_run_id)
    ?? snapshot?.runId
    ?? nodeId;

  return {
    workspaceId: cleanString(event.workspace_id)
      ?? snapshot?.workspaceId
      ?? projection?.workspaceId
      ?? tracked?.workspaceId
      ?? deps.getSelectedWorkspaceId(),
    parentId: cleanString(event.parent_id)
      ?? cleanString(event.user_node_id)
      ?? snapshot?.parentId
      ?? projection?.parentId
      ?? tracked?.parentId
      ?? null,
    role: 'assistant',
    agentId: cleanString(event.agent_id)
      ?? snapshot?.agentId
      ?? projection?.agent_id
      ?? tracked?.agent_id
      ?? null,
    runId,
    status: cleanStatus(event.status) as any
      ?? snapshot?.status as any
      ?? projection?.status as any
      ?? tracked?.status as any
      ?? null,
    executionData: {
      ...executionData,
      current_run_id: runId,
    },
  };
};

const receiveNativeEvent = (
  nodeId: string,
  event: Record<string, any>,
  deps: CoordinatorDeps,
) => {
  if (event.type === 'finalize_ack') {
    const message = cleanString(event.landing_warning) ?? cleanString(event.landingWarning);
    if (message) {
      deps.onLandingWarning?.({
        nodeId,
        message,
        outputCommitSha: cleanString(event.output_commit_sha)
          ?? cleanString(event.outputCommitSha)
          ?? cleanString(event.commit_sha),
      });
    }
  }
  const input = buildInput(nodeId, event, deps);
  const state = getStreamState(nodeId);
  ingestAgentRunStreamEvent(nodeId, event, input, state);

  const snapshot = agentRunManager.snapshot(nodeId);
  if (snapshot?.content !== undefined) {
    state.output = snapshot.content;
  }
  if (snapshot?.status && !isActiveAgentStatus(snapshot.status)) {
    trackedMessages.delete(nodeId);
  }
};

export const isAgentRunLiveStreamCoordinatorActive = () => activeCoordinatorCount > 0;

export const trackAgentRunLiveStreamMessage = (message: Message) => {
  trackedMessages.set(message.id, message);
  const existing = streamStates.get(message.id);
  if (!existing) {
    streamStates.set(message.id, {
      output: message.content ?? '',
      providerItemId: null,
    });
  }
};

export const untrackAgentRunLiveStreamNode = (nodeId: string) => {
  trackedMessages.delete(nodeId);
  streamStates.delete(nodeId);
};

export const clearTrackedAgentRunLiveStreams = () => {
  trackedMessages.clear();
  streamStates.clear();
};

const clearNativeSubscriptionRetry = () => {
  if (nativeSubscriptionRetryTimer !== null) {
    clearTimeout(nativeSubscriptionRetryTimer);
    nativeSubscriptionRetryTimer = null;
  }
};

const subscribeToNativeStream = (deps: CoordinatorDeps) => {
  if (
    activeCoordinatorCount <= 0
    || nativeUnlisten
    || nativeSubscriptionPromise
    || nativeSubscriptionRetryTimer !== null
  ) {
    return;
  }

  nativeSubscriptionPromise = agentClient.onEvent(({ nodeId, event }) => {
    if (!nodeId || !event) return;
    receiveNativeEvent(nodeId, event, deps);
  }).then((unlisten) => {
    nativeUnlisten = unlisten;
    nativeSubscriptionPromise = null;
    nativeSubscriptionRetryCount = 0;
    if (activeCoordinatorCount <= 0) {
      nativeUnlisten();
      nativeUnlisten = null;
    }
    return unlisten;
  }).catch((error) => {
    nativeSubscriptionPromise = null;
    console.error('[AgentRunLiveStreamCoordinator] Failed to subscribe to Tauri agent stream:', error);

    if (
      activeCoordinatorCount <= 0
      || nativeSubscriptionRetryCount >= MAX_NATIVE_SUBSCRIPTION_RETRIES
    ) {
      return () => undefined;
    }

    const retryDelay = NATIVE_SUBSCRIPTION_RETRY_DELAY_MS * (2 ** nativeSubscriptionRetryCount);
    nativeSubscriptionRetryCount += 1;
    nativeSubscriptionRetryTimer = setTimeout(() => {
      nativeSubscriptionRetryTimer = null;
      subscribeToNativeStream(deps);
    }, retryDelay);
    return () => undefined;
  });
};

export const startAgentRunLiveStreamCoordinator = (deps: CoordinatorDeps): StopSubscription => {
  const isFreshMount = activeCoordinatorCount === 0;
  activeCoordinatorCount += 1;
  let stopped = false;

  if (isFreshMount) {
    nativeSubscriptionRetryCount = 0;
  }
  subscribeToNativeStream(deps);

  return () => {
    if (stopped) return;
    stopped = true;
    activeCoordinatorCount = Math.max(0, activeCoordinatorCount - 1);
    if (activeCoordinatorCount > 0) return;
    clearNativeSubscriptionRetry();
    nativeSubscriptionRetryCount = 0;
    if (nativeUnlisten) {
      nativeUnlisten();
      nativeUnlisten = null;
    }
  };
};
