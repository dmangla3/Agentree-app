import { agentRunManager } from './agentRunManager';
import type { RuntimeProvider } from '../lib/providerContinuation';
import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';
import { useProviderLimitsStore } from '../stores/providerLimitsStore';

type AgentDescriptor = {
  id: string;
  type?: string | null;
};

export type AgentRunStreamDispatchContext = {
  nodeId: string;
  parentId: string;
  workspaceId: string;
  agentId?: string | null;
  currentOutput: string;
  getProjection: (nodeId: string) => AgentRunProjectedMessage | null;
  getAgents: () => AgentDescriptor[];
  setSetupProgress: (nodeId: string, progress: string) => void;
};

export const deriveIncrementalText = (previousText: string, nextText: string) => {
  const previous = typeof previousText === 'string' ? previousText : '';
  const next = typeof nextText === 'string' ? nextText : '';
  if (!next) return '';
  if (!previous) return next;
  if (next === previous) return '';
  if (next.startsWith(previous)) return next.slice(previous.length);
  if (previous.startsWith(next)) return '';
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.endsWith(next.slice(0, overlap))) {
      return next.slice(overlap);
    }
  }
  return previous.includes(next) ? '' : next;
};

export const deriveStreamingAppendText = (
  actorContent: string | null | undefined,
  projectedContent: string,
  nextOutput: string,
) => deriveIncrementalText(
  typeof actorContent === 'string' ? actorContent : projectedContent,
  nextOutput,
);

export const extractMessageText = (payload: any): string => {
  if (!payload) return '';
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.text === 'string') return payload.text;
  if (payload.message?.content && Array.isArray(payload.message.content)) {
    return payload.message.content
      .map((block: any) => {
        if (!block) return '';
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        return '';
      })
      .join('');
  }
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((block: any) => {
        if (!block) return '';
        if (typeof block === 'string') return block;
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        return '';
      })
      .join('');
  }
  return '';
};

export const mergeStreamingOutput = (currentOutput: string, nextText: string) => {
  const incoming = typeof nextText === 'string' ? nextText : '';
  if (!incoming) return currentOutput;
  if (!currentOutput) return incoming;
  if (incoming.startsWith(currentOutput)) return incoming;
  if (currentOutput.startsWith(incoming)) return currentOutput;
  if (currentOutput.endsWith(incoming)) return currentOutput;
  return `${currentOutput}${incoming}`;
};

type ProviderAssistantOutputKind = 'delta' | 'snapshot' | 'final';

const cleanProviderItemId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const resolveProviderAssistantOutput = (
  currentOutput: string,
  nextText: string,
  options: {
    kind: ProviderAssistantOutputKind;
    currentProviderItemId?: string | null;
    nextProviderItemId?: string | null;
  },
) => {
  const incoming = typeof nextText === 'string' ? nextText : '';
  const currentProviderItemId = cleanProviderItemId(options.currentProviderItemId);
  const nextProviderItemId = cleanProviderItemId(options.nextProviderItemId);
  const providerItemChanged = Boolean(
    currentProviderItemId &&
    nextProviderItemId &&
    currentProviderItemId !== nextProviderItemId
  );
  const providerItemId = nextProviderItemId ?? currentProviderItemId;

  if (!incoming) {
    return { output: currentOutput, providerItemId };
  }
  if (options.kind === 'final' || providerItemChanged) {
    return { output: incoming, providerItemId };
  }
  if (options.kind === 'delta') {
    return { output: `${currentOutput}${incoming}`, providerItemId };
  }
  return { output: mergeStreamingOutput(currentOutput, incoming), providerItemId };
};

const mergeExecutionData = (
  currentExecution: Record<string, any>,
  patch: Record<string, any>,
) => ({
  ...currentExecution,
  ...patch,
  ...((currentExecution.meta || patch.meta) ? {
    meta: {
      ...(currentExecution.meta || {}),
      ...(patch.meta || {}),
    },
  } : {}),
  ...((currentExecution.usage || patch.usage) ? {
    usage: {
      ...(currentExecution.usage || {}),
      ...(patch.usage || {}),
    },
  } : {}),
});

export const dispatchAgentRunExecutionData = (
  nodeId: string,
  patch: Record<string, any>,
  getProjection: (nodeId: string) => AgentRunProjectedMessage | null,
) => {
  const current = getProjection(nodeId);
  if (!current) return;
  agentRunManager.dispatch(nodeId, {
    type: 'execution_data',
    patch: mergeExecutionData((current.execution_data || {}) as Record<string, any>, patch),
  });
};

export const dispatchAgentRunUsage = (
  usage: any,
  context: Pick<AgentRunStreamDispatchContext, 'nodeId' | 'parentId' | 'workspaceId' | 'agentId'>,
) => {
  if (!usage) return;
  agentRunManager.dispatch(context.nodeId, { type: 'usage', usage }, {
    workspaceId: context.workspaceId,
    parentId: context.parentId,
    role: 'assistant',
    agentId: context.agentId || null,
    executionData: { timeline: [] },
  });
};

export const dispatchStreamingAssistantText = (
  nextContent: string,
  options: Pick<AgentRunStreamDispatchContext, 'nodeId' | 'parentId' | 'workspaceId' | 'agentId'> & {
    appendedText?: string;
    timestamp?: number;
    streamSeq?: number | null;
  },
) => {
  agentRunManager.dispatch(options.nodeId, {
    type: 'content',
    content: nextContent,
    appendedText: options.appendedText || '',
    timestamp: options.timestamp ?? Date.now(),
    streamSeq: options.streamSeq ?? null,
  }, {
    workspaceId: options.workspaceId,
    parentId: options.parentId,
    role: 'assistant',
    agentId: options.agentId || null,
    content: nextContent,
    executionData: { timeline: [] },
  });
};

export const dispatchTimelineEvent = (
  event: any,
  context: Pick<AgentRunStreamDispatchContext, 'nodeId' | 'parentId' | 'workspaceId' | 'agentId' | 'currentOutput'>,
) => {
  agentRunManager.dispatch(context.nodeId, { type: 'timeline_event', event }, {
    workspaceId: context.workspaceId,
    parentId: context.parentId,
    role: 'assistant',
    agentId: context.agentId || null,
    content: context.currentOutput,
    executionData: { timeline: [] },
  });
};

export const dispatchProviderStreamEvent = (
  data: any,
  context: AgentRunStreamDispatchContext,
) => {
  const maybePromoteLiveActivity = (text: string | null) => {
    if ((context.currentOutput || '').trim().length > 0) return;
    const normalized = (text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    context.setSetupProgress(context.nodeId, normalized.slice(0, 140));
  };

  const mergeProviderMeta = (meta: Record<string, any>) => {
    dispatchAgentRunExecutionData(context.nodeId, { meta }, context.getProjection);
    const providerFromMeta = typeof meta.provider === 'string' ? meta.provider : null;
    const providerFromAgent = context.getAgents().find((agent) => agent.id === context.agentId)?.type ?? null;
    const provider = (providerFromMeta || providerFromAgent) as RuntimeProvider | null;
    if (provider === 'claude' || provider === 'codex') {
      useProviderLimitsStore.getState().upsertFromMeta(provider, meta);
    }
  };

  if (data.type === 'provider_meta' && data.meta && typeof data.meta === 'object') {
    mergeProviderMeta(data.meta);
  } else if (data.type === 'thinking') {
    maybePromoteLiveActivity(data.thinking || data.content || null);
    dispatchTimelineEvent({
      type: 'thinking',
      timestamp: Date.now(),
      content: data.thinking || data.content,
    }, context);
  } else if (data.type === 'tool_use') {
    maybePromoteLiveActivity(`Running ${data.name || data.toolName || data.tool_name || 'tool'}...`);
    if (data.tool_input?.description) {
      dispatchTimelineEvent({
        type: 'thinking',
        timestamp: Date.now(),
        content: data.tool_input.description,
      }, context);
    }
    dispatchTimelineEvent({
      type: 'tool_use',
      timestamp: Date.now(),
      toolName: data.name || data.toolName || data.tool_name,
      toolInput: data.tool_input ?? data.toolInput ?? data.input,
      toolUseId: data.id || data.toolUseId || data.tool_use_id,
      commandActions: data.commandActions ?? data.command_actions ?? data.provider_item?.commandActions ?? data.provider_item?.command_actions,
      providerItem: data.provider_item ?? data.providerItem,
      provider_item_id: data.provider_item_id ?? data.id ?? data.toolUseId ?? data.tool_use_id,
    }, context);
  } else if (data.type === 'tool_result') {
    maybePromoteLiveActivity(`Finished ${data.toolName || data.tool_name || data.name || 'tool'}`);
    dispatchTimelineEvent({
      type: 'tool_result',
      timestamp: Date.now(),
      toolName: data.toolName || data.tool_name || data.name || 'unknown',
      toolOutput: data.content ?? data.toolOutput ?? data.tool_output ?? data.output,
      isError: data.is_error,
      toolUseId: data.toolUseId || data.tool_use_id || data.id,
    }, context);
  } else if (data.type === 'tool_output_delta') {
    dispatchTimelineEvent({
      type: 'tool_output_delta',
      timestamp: Date.now(),
      toolUseId: data.toolUseId || data.tool_use_id || data.id,
      delta: data.delta,
    }, context);
  } else if (data.type === 'user_steer_requested') {
    dispatchTimelineEvent({
      type: 'user_steer_requested',
      timestamp: data.timestamp ?? Date.now(),
      content: data.content,
      idempotencyKey: data.idempotency_key,
    }, context);
  } else if (data.type === 'stop' || data.type === 'provider_stop' || data.type === 'result') {
    // Inner stop/result events are emitted on stdout by wrappers. Do not
    // teardown here; wait for top-level exit/stop so git finalization runs.
    dispatchTimelineEvent({
      type: 'thinking',
      timestamp: Date.now(),
      content: '[Agent run completed, finalizing changes...]',
    }, context);
  } else if (data.type === 'message') {
    const current = context.getProjection(context.nodeId);
    const currentContent = typeof current?.content === 'string' ? current.content : '';
    const appended = deriveIncrementalText(currentContent, context.currentOutput);
    dispatchStreamingAssistantText(context.currentOutput, {
      ...context,
      appendedText: appended,
      timestamp: Date.now(),
    });
  } else if (data.type === 'error') {
    const errorText = typeof data.data === 'string' ? data.data : (typeof data.content === 'string' ? data.content : '');
    if (errorText) {
      dispatchTimelineEvent({ type: 'error', timestamp: Date.now(), content: errorText }, context);
    }
  } else if (data.type === 'stderr') {
    const warningText = typeof data.data === 'string' ? data.data : (typeof data.content === 'string' ? data.content : '');
    if (warningText) {
      dispatchTimelineEvent({ type: 'error', timestamp: Date.now(), content: warningText }, context);
    }
  }
};
