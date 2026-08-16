import { memo, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Wrench, Layers, Zap } from 'lucide-react';
import { TimelineRowWrapper } from './TimelineRowWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { getAgentColorClass } from '../../../lib/graphUtils';
import { useAgents } from '../../../hooks/useAgents';
import type { AgentStatus } from '@shared/agentStatus';
import { getAgentVisualState } from '../../../lib/agentStateUI';
import { AgentStateOverlay } from '../../AgentStateOverlay';
import { useRunStatusStore } from '../../../stores/runStatusStore';
import { useAgentRunProjectionStore } from '../../../stores/agentRunProjectionStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { isTerminalNodeStatus, resolveNodeState } from '../../../lib/runStateResolver';
import { api } from '../../../lib/api';
import { agentClient } from '../../../lib/agentClient';
import type { Message } from '../../../stores/workspaceStore';
import type { GraphSnapshot } from '../../../hooks/useGraphSnapshot';
import { getAssistantIdentityLabel } from '../../../lib/assistantIdentity';

const ACTIVE_STATUSES = new Set(['pending', 'creating', 'initializing', 'running', 'streaming']);
const CACHE_REPAIR_TIMELINE_ACTIVE_STATUS_REFRESH_COOLDOWN_MS = 15_000;
const cacheRepairTimelineRefreshAtByMessageId = new Map<string, number>();
const cacheRepairTimelineRefreshInFlightByMessageId = new Set<string>();

const terminalStatusFromMessage = (message: Message): AgentStatus | null => {
  const executionData = (message.execution_data ?? {}) as Record<string, any>;
  const terminalStatus = executionData.last_terminal_status;
  if (isTerminalNodeStatus(terminalStatus)) return terminalStatus as AgentStatus;
  if (isTerminalNodeStatus(message.status)) return message.status as AgentStatus;
  return null;
};

// Compact status icon only
const StatusIcon = ({ status }: { status: AgentStatus | null | undefined }) => {
  if (!status) return null;

  const config = getAgentVisualState(status);
  const Icon = config.icon;

  return (
    <div
      className={cn("p-1 rounded bg-white dark:bg-slate-900 z-10 relative", config.colorClass)}
      title={`Agent ${config.label}`}
    >
      <Icon size={11} className={cn(config.animate && "animate-spin")} />
    </div>
  );
};

// Beautiful small chip for agent name
const AgentChip = ({
  agentId,
  llmModel,
  llmProvider,
}: {
  agentId?: string | null;
  llmModel?: string | null;
  llmProvider?: string | null;
}) => {
  const { data: agents = [] } = useAgents();
  const agent = agents.find(a => a.id === agentId);

  const name = getAssistantIdentityLabel({
    agentName: agent?.name,
    llmModel,
    llmProvider,
  });
  const colorName = agent?.color;
  const colorClass = getAgentColorClass(colorName) || 'bg-slate-500';

  return (
    <div className={cn(
      "px-1.5 py-0.5 rounded text-[8px] font-bold text-white shadow-sm uppercase tracking-wider leading-none shrink-0",
      colorClass
    )}>
      {name}
    </div>
  );
};

const AiLabelChip = ({ aiLabel }: { aiLabel?: string | null }) => {
  const label = aiLabel?.trim();
  if (!label) return null;

  return (
    <div
      className="max-w-[10rem] truncate rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[8px] font-medium leading-none text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
      title={`AI label: ${label}`}
    >
      {label}
    </div>
  );
};

export const TimelineAssistantRow = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  showSelectionControl,
  disableHoverCard,
  hoverCardContent,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const queryClient = useQueryClient();
  const selectedWorkspaceId = useWorkspaceStore(state => state.selectedWorkspaceId);
  const [serverTerminalStatus, setServerTerminalStatus] = useState<AgentStatus | null>(null);
  const messageId = entity.message?.id ?? entity.messageId ?? null;
  const runStatus = useRunStatusStore(state => messageId ? state.byNodeId[messageId]?.status ?? null : null);
  const liveMessage = useAgentRunProjectionStore(state => messageId ? state.projectionsById[messageId] ?? null : null);
  const resolvedStatus = resolveNodeState(entity.message ?? null, liveMessage).status ?? entity.status;
  const runtimeStatus = isTerminalNodeStatus(resolvedStatus) ? resolvedStatus : (runStatus || resolvedStatus);
  const displayStatus = serverTerminalStatus ?? runtimeStatus;
  const workspaceId = entity.message?.workspaceId ?? selectedWorkspaceId ?? null;

  useEffect(() => {
    if (!messageId || !workspaceId) return;
    if (liveMessage) return;
    if (!displayStatus || !ACTIVE_STATUSES.has(String(displayStatus))) return;

    const now = Date.now();
    const lastRefreshAt = cacheRepairTimelineRefreshAtByMessageId.get(messageId) ?? 0;
    if (now - lastRefreshAt < CACHE_REPAIR_TIMELINE_ACTIVE_STATUS_REFRESH_COOLDOWN_MS) return;
    cacheRepairTimelineRefreshAtByMessageId.set(messageId, now);

    void queryClient.invalidateQueries({ queryKey: ['messages', workspaceId], refetchType: 'active' });
    void queryClient.invalidateQueries({ queryKey: ['graph-snapshot', workspaceId], refetchType: 'active' });
    if (cacheRepairTimelineRefreshInFlightByMessageId.has(messageId)) return;
    cacheRepairTimelineRefreshInFlightByMessageId.add(messageId);
    void api.get<Message[]>(`/workspaces/${workspaceId}/messages`)
      .then((response) => {
        const serverMessage = Array.isArray(response.data)
          ? response.data.find((message) => message.id === messageId)
          : null;
        if (!serverMessage) return;
        const terminalStatus = terminalStatusFromMessage(serverMessage);
        if (terminalStatus) {
          setServerTerminalStatus(terminalStatus);
        }
        void agentClient
          .hydrateLocalNodesFromServer(workspaceId, [serverMessage])
          .finally(() => {
            queryClient.invalidateQueries({ queryKey: ['messages', workspaceId], refetchType: 'active' });
          });
        queryClient.setQueryData<GraphSnapshot | undefined>(['graph-snapshot', workspaceId], (current) => {
          if (!current || !Array.isArray(current.messages)) return current;
          let didChange = false;
          const nextMessages = current.messages.map((message) => {
            if (message.id !== messageId) return message;
            didChange = true;
            return {
              ...message,
              ...serverMessage,
              contentPreview: serverMessage.content?.slice(0, 240) ?? message.contentPreview ?? '',
              contentLength: serverMessage.content?.length ?? message.contentLength ?? 0,
            };
          });
          return didChange
            ? { ...current, messages: nextMessages, generatedAt: new Date().toISOString(), cacheWriteDisabled: true }
            : current;
        });
      })
      .finally(() => {
        cacheRepairTimelineRefreshInFlightByMessageId.delete(messageId);
      });
  }, [displayStatus, liveMessage, messageId, queryClient, workspaceId]);

  const timestamp = entity.message?.createdAt
    ? new Date(entity.message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';

  return (
    <TimelineRowWrapper
      rowId={nodeId}
      messageId={messageId}
      isFocused={isFocused}
      isSelected={isSelected}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      showSelectionControl={showSelectionControl}
      disableHoverCard={disableHoverCard}
      hoverCardContent={hoverCardContent}
      className={cn(
        ROLE_COLORS.assistant_message.bg,
        ROLE_COLORS.assistant_message.border,
        "border shadow-sm mx-2"
      )}
    >
      <AgentStateOverlay status={displayStatus as any} />

      {/* Content */}
      <p className={cn("text-sm font-medium whitespace-normal break-words leading-snug min-w-0 line-clamp-2", ROLE_COLORS.assistant_message.text)}>
        {entity.preview}
      </p>

      {/* Compact metrics & icons at bottom */}
      <div className="flex flex-wrap items-center gap-2 mt-1 gap-y-1 text-[10px] text-slate-500 w-full">
        <StatusIcon status={displayStatus as any} />
        <AgentChip
          agentId={entity.message?.agent_id}
          llmModel={entity.message?.llmModel}
          llmProvider={entity.message?.llmProvider}
        />
        <AiLabelChip aiLabel={entity.message?.aiLabel} />

        {entity.toolCallCount !== undefined && entity.toolCallCount > 0 && (
          <div className="flex items-center gap-0.5" title={`${entity.toolCallCount} tool calls`}>
            <Wrench size={10} className="text-sky-500" />
            <span className="tabular-nums">{entity.toolCallCount}</span>
          </div>
        )}

        {entity.commitCount !== undefined && entity.commitCount > 0 && (
          <div className="flex items-center gap-0.5" title={`${entity.commitCount} commits`}>
            <Layers size={10} className="text-emerald-500" />
            <span className="tabular-nums">{entity.commitCount}</span>
          </div>
        )}

        {entity.totalTokens !== undefined && entity.totalTokens !== null && entity.totalTokens > 0 && (
          <div className="flex items-center gap-0.5" title={`${entity.totalTokens.toLocaleString()} tokens`}>
            <Zap size={10} className="text-amber-500" />
            <span className="tabular-nums">{(entity.totalTokens / 1000).toFixed(1)}k</span>
          </div>
        )}

        <div className="ml-auto flex items-center shrink-0 text-[10px] font-medium text-slate-400 tabular-nums">
          {timestamp}
        </div>
      </div>
    </TimelineRowWrapper>
  );
});

TimelineAssistantRow.displayName = 'TimelineAssistantRow';
