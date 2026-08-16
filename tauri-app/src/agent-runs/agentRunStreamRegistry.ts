export type AgentRunStreamMode = 'background' | 'promoting' | 'full';

export interface AgentRunStreamNodeContext {
  nodeId: string;
  workspaceId: string | null;
  parentId: string | null;
  role: string | null;
}

export type FullStreamHandler = (event: Record<string, any>) => void;

export interface BackgroundStreamResult {
  terminalHydration: boolean;
}

interface BackgroundEntry extends AgentRunStreamNodeContext {
  mode: 'background';
}

interface PromotingEntry extends AgentRunStreamNodeContext {
  mode: 'promoting';
  fullHandler: FullStreamHandler;
  buffer: Record<string, any>[];
}

interface FullEntry extends AgentRunStreamNodeContext {
  mode: 'full';
  fullHandler: FullStreamHandler;
}

type Entry = BackgroundEntry | PromotingEntry | FullEntry;

export const createAgentRunStreamRegistry = (deps: {
  background: (context: AgentRunStreamNodeContext, event: Record<string, any>) => BackgroundStreamResult;
  onTerminalHydration?: (context: AgentRunStreamNodeContext, event: Record<string, any>) => void;
}) => {
  const entries = new Map<string, Entry>();

  const registerBackground = (context: AgentRunStreamNodeContext) => {
    const existing = entries.get(context.nodeId);
    if (existing?.mode === 'promoting') return;
    entries.set(context.nodeId, { ...context, mode: 'background' });
  };

  const beginPromotion = (context: AgentRunStreamNodeContext & { fullHandler: FullStreamHandler }) => {
    entries.set(context.nodeId, {
      nodeId: context.nodeId,
      workspaceId: context.workspaceId,
      parentId: context.parentId,
      role: context.role,
      mode: 'promoting',
      fullHandler: context.fullHandler,
      buffer: [],
    });
  };

  const finishPromotion = (nodeId: string) => {
    const existing = entries.get(nodeId);
    if (!existing || existing.mode !== 'promoting') return;
    for (const event of existing.buffer) {
      existing.fullHandler(event);
    }
    entries.set(nodeId, {
      nodeId: existing.nodeId,
      workspaceId: existing.workspaceId,
      parentId: existing.parentId,
      role: existing.role,
      mode: 'full',
      fullHandler: existing.fullHandler,
    });
  };

  const deliverReplayEvent = (nodeId: string, event: Record<string, any>) => {
    const existing = entries.get(nodeId);
    if (!existing || existing.mode === 'background') return;
    existing.fullHandler(event);
  };

  const receive = (nodeId: string, event: Record<string, any>) => {
    const existing = entries.get(nodeId);
    if (!existing) return;
    if (existing.mode === 'full') {
      existing.fullHandler(event);
      return;
    }
    if (existing.mode === 'promoting') {
      existing.buffer.push(event);
      return;
    }
    const result = deps.background(existing, event);
    if (result.terminalHydration) {
      deps.onTerminalHydration?.(existing, event);
    }
  };

  return {
    registerBackground,
    beginPromotion,
    finishPromotion,
    deliverReplayEvent,
    receive,
    unregister(nodeId: string) {
      entries.delete(nodeId);
    },
    clear() {
      entries.clear();
    },
    has(nodeId: string) {
      return entries.has(nodeId);
    },
    mode(nodeId: string): AgentRunStreamMode | null {
      return entries.get(nodeId)?.mode ?? null;
    },
    context(nodeId: string): AgentRunStreamNodeContext | null {
      const existing = entries.get(nodeId);
      if (!existing) return null;
      return {
        nodeId: existing.nodeId,
        workspaceId: existing.workspaceId,
        parentId: existing.parentId,
        role: existing.role,
      };
    },
  };
};
