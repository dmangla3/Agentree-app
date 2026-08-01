import { create } from 'zustand';
import type { Message } from './workspaceStore';

/**
 * UI projection of an AgentRunActor snapshot.
 *
 * This store is not the lifecycle authority for agent runs. AgentRunActor owns
 * status, phase, streamed content, seq cursors, timeline, usage, terminal
 * state, and cleanup timing. This store only keeps the render-facing overlay
 * that chat/graph/timeline selectors merge with persisted server messages.
 *
 * New lifecycle writes should go through agentRunManager/AgentRunActor. The
 * only production code that should call setProjectionForNode/clearProjectionForNode
 * for run updates is the actor effect bridge in agentRunEffects.ts.
 */
export interface AgentRunProjectedMessage extends Message {
  _optimistic?: boolean;
  _optimisticStatus?: 'pending' | 'creating' | 'initializing' | 'running' | 'completed' | 'failed' | 'cancelled';
  _optimisticError?: string | null;
  _setupProgress?: string;
  _rollbackOnFail?: boolean;
  _terminalHoldUntil?: number;
  _terminalContentLength?: number;
}

const AGENT_RUN_PROJECTION_DEBUG_ENABLED = ['1', 'true', 'yes'].includes(String(import.meta.env.VITE_AGENT_RUN_PROJECTION_DEBUG || '').toLowerCase());

interface PendingOperation {
  nodeId: string;
  abortController: AbortController;
  startedAt: number;
}

interface AgentRunProjectionState {
  // Render-facing actor projections by message/node id.
  projectionsById: Record<string, AgentRunProjectedMessage>;

  // Abort-controller registry for local request setup. This is operational
  // plumbing, not the source of run lifecycle truth.
  pendingOperations: Record<string, PendingOperation>;
  
  // Projection cache operations. Prefer agentRunManager for lifecycle changes.
  setProjectionForNode: (nodeId: string, message: AgentRunProjectedMessage | null) => void;
  clearProjectionForNode: (nodeId: string) => void;
  clearAllProjections: () => void;

  // Pending operation tracking
  registerPendingOperation: (nodeId: string, abortController: AbortController) => void;
  unregisterPendingOperation: (nodeId: string) => AbortController | null;
  cancelPendingOperation: (nodeId: string) => boolean;
  getPendingOperation: (nodeId: string) => PendingOperation | null;
  
}

export const useAgentRunProjectionStore = create<AgentRunProjectionState>((set, get) => ({
  projectionsById: {},
  pendingOperations: {},

  setProjectionForNode: (nodeId, message) =>
    set((state) => {
      if (!message) {
        const next = { ...state.projectionsById };
        delete next[nodeId];
        return { projectionsById: next };
      }
      const nextMessage: AgentRunProjectedMessage = {
        ...message,
      };
      return {
        projectionsById: {
          ...state.projectionsById,
          [nodeId]: nextMessage,
        },
      };
    }),

  clearProjectionForNode: (nodeId) =>
    set((state) => {
      const existing = state.projectionsById[nodeId];
      if (AGENT_RUN_PROJECTION_DEBUG_ENABLED) {
        console.log('[ExecutionTimeline] clearProjectionForNode', {
          nodeId,
          status: existing?.status,
          optimisticStatus: existing?._optimisticStatus,
          timelineCount: (((existing?.execution_data as any)?.timeline) || []).length,
          contentLength: existing?.content?.length || 0,
        });
      }
      const next = { ...state.projectionsById };
      delete next[nodeId];
      const nextOps = { ...state.pendingOperations };
      delete nextOps[nodeId];
      return { projectionsById: next, pendingOperations: nextOps };
    }),

  clearAllProjections: () => {
    set({ projectionsById: {}, pendingOperations: {} });
  },

  registerPendingOperation: (nodeId, abortController) =>
    set((state) => ({
      pendingOperations: {
        ...state.pendingOperations,
        [nodeId]: {
          nodeId,
          abortController,
          startedAt: Date.now(),
        },
      },
    })),

  unregisterPendingOperation: (nodeId) => {
    const operation = get().pendingOperations[nodeId];
    if (operation) {
      set((state) => {
        const next = { ...state.pendingOperations };
        delete next[nodeId];
        return { pendingOperations: next };
      });
    }
    return operation?.abortController || null;
  },

  cancelPendingOperation: (nodeId) => {
    const operation = get().pendingOperations[nodeId];
    if (operation && !operation.abortController.signal.aborted) {
      operation.abortController.abort();
      set((state) => {
        const next = { ...state.pendingOperations };
        delete next[nodeId];
        return { pendingOperations: next };
      });
      return true;
    }
    return false;
  },

  getPendingOperation: (nodeId) => get().pendingOperations[nodeId] || null,
}));

// AgentRunProjectedMessage is exported above for projection consumers.
