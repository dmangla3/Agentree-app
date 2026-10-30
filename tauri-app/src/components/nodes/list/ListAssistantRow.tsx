import { memo, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Wrench, Layers, Zap } from 'lucide-react';
import { ListRowWrapper } from './ListRowWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS } from '../../../lib/visualTokens';
import { getAgentColorClass } from '../../../lib/graphUtils';
import { useAgents } from '../../../hooks/useAgents';
import type { AgentStatus } from '@shared/agentStatus';
import { isActiveAgentStatus } from '@shared/agentStatus';
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
import { getAssistantIdentityParts, getAssistantReasoningEffortFromExecutionData } from '../../../lib/assistantIdentity';
import { getNodeFailureReason, isNodeFailureStatus } from '../../../lib/nodeFailureReason';

const CACHE_REPAIR_LIST_ACTIVE_STATUS_REFRESH_COOLDOWN_MS = 15_000;
const cacheRepairListRefreshAtByMessageId = new Map<string, number>();
const cacheRepairListRefreshInFlightByMessageId = new Set<string>();

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
      className={cn("relative z-10 rounded border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.72)] p-1 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)] dark:bg-white/[0.04]", config.colorClass)}
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
  reasoningEffort,
}: {
  agentId?: string | null;
  llmModel?: string | null;
  llmProvider?: string | null;
  reasoningEffort?: string | null;
}) => {
  const { data: agents = [] } = useAgents();
  const agent = agents.find(a => a.id === agentId);

  const { label, reasoningEffort: reasoningEffortLabel } = getAssistantIdentityParts({
    agentName: agent?.name,
    llmModel,
    llmProvider,
    reasoningEffort,
  });
  const colorName = agent?.color;
  const colorClass = getAgentColorClass(colorName) || 'bg-[hsl(var(--app-graph-agent))]';

  return (
    <div data-design-typography="soft-on-color-bold" className={cn(
      "shrink-0 rounded px-1.5 py-0.5 text-[8px] font-medium uppercase leading-none tracking-wider text-[hsl(40_24%_96%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]",
      colorClass
    )}>
      {label}
      {reasoningEffortLabel && (
        <span className="ml-1 normal-case">{reasoningEffortLabel}</span>
      )}
    </div>
  );
};

const AiLabelChip = ({ aiLabel }: { aiLabel?: string | null }) => {
  const label = aiLabel?.trim();
  if (!label) return null;

  return (
    <div
      className="max-w-[10rem] truncate rounded border border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel-strong)/0.58)] px-1.5 py-0.5 text-[8px] font-medium leading-none text-muted-foreground dark:bg-white/[0.04]"
      title={`AI label: ${label}`}
    >
      {label}
    </div>
  );
};

export const ListAssistantRow = memo(({
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
  const failureReason = isNodeFailureStatus(displayStatus)
    ? getNodeFailureReason(entity.message?.execution_data, entity.preview)
    : null;

  useEffect(() => {
    if (!messageId || !workspaceId) return;
    if (liveMessage) return;
    if (!isActiveAgentStatus(displayStatus)) return;

    const now = Date.now();
    const lastRefreshAt = cacheRepairListRefreshAtByMessageId.get(messageId) ?? 0;
    if (now - lastRefreshAt < CACHE_REPAIR_LIST_ACTIVE_STATUS_REFRESH_COOLDOWN_MS) return;
    cacheRepairListRefreshAtByMessageId.set(messageId, now);

    void queryClient.invalidateQueries({ queryKey: ['messages', workspaceId], refetchType: 'active' });
    void queryClient.invalidateQueries({ queryKey: ['graph-snapshot', workspaceId], refetchType: 'active' });
    if (cacheRepairListRefreshInFlightByMessageId.has(messageId)) return;
    cacheRepairListRefreshInFlightByMessageId.add(messageId);
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
        cacheRepairListRefreshInFlightByMessageId.delete(messageId);
      });
  }, [displayStatus, liveMessage, messageId, queryClient, workspaceId]);

  const timestamp = entity.message?.createdAt
    ? new Date(entity.message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';

  return (
    <ListRowWrapper
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
        "mx-1 bg-[hsl(var(--app-panel)/0.72)] text-foreground dark:bg-white/[0.035]",
        "border-[hsl(var(--app-border)/0.64)]"
      )}
    >
      <AgentStateOverlay status={displayStatus as any} />

      {/* Content */}
      <p className={cn("text-sm font-medium whitespace-normal break-words leading-snug min-w-0 line-clamp-2", ROLE_COLORS.assistant_message.text)}>
        {failureReason ?? entity.preview}
      </p>

      {/* Compact metrics & icons at bottom */}
      <div className="mt-1 flex w-full flex-wrap items-center gap-2 gap-y-1 text-[10px] text-muted-foreground">
        <StatusIcon status={displayStatus as any} />
        <AgentChip
          agentId={entity.message?.agent_id}
          llmModel={entity.message?.llmModel}
          llmProvider={entity.message?.llmProvider}
          reasoningEffort={getAssistantReasoningEffortFromExecutionData(entity.message?.execution_data)}
        />
        <AiLabelChip aiLabel={entity.message?.aiLabel} />

        {entity.toolCallCount !== undefined && entity.toolCallCount > 0 && (
          <div className="flex items-center gap-0.5" title={`${entity.toolCallCount} tool calls`}>
            <Wrench size={10} className="text-[hsl(var(--app-graph-agent))]" />
            <span className="tabular-nums">{entity.toolCallCount}</span>
          </div>
        )}

        {entity.commitCount !== undefined && entity.commitCount > 0 && (
          <div className="flex items-center gap-0.5" title={`${entity.commitCount} commits`}>
            <Layers size={10} className="text-[hsl(var(--app-graph-commit))]" />
            <span className="tabular-nums">{entity.commitCount}</span>
          </div>
        )}

        {entity.totalTokens !== undefined && entity.totalTokens !== null && entity.totalTokens > 0 && (
          <div className="flex items-center gap-0.5" title={`${entity.totalTokens.toLocaleString()} tokens`}>
            <Zap size={10} className="text-[hsl(var(--app-graph-external))]" />
            <span className="tabular-nums">{(entity.totalTokens / 1000).toFixed(1)}k</span>
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center text-[10px] font-medium text-muted-foreground/70 tabular-nums">
          {timestamp}
        </div>
      </div>
    </ListRowWrapper>
  );
});

ListAssistantRow.displayName = 'ListAssistantRow';
