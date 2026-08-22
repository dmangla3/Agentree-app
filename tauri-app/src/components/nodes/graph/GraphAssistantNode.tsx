import { memo } from 'react';
import { Bot, GitCommitHorizontal, Wrench, Zap } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import type { AgentStatus } from '@shared/agentStatus';
import { getAgentVisualState } from '../../../lib/agentStateUI';
import { useRunStatusStore } from '../../../stores/runStatusStore';
import { getAssistantIdentityLabel } from '../../../lib/assistantIdentity';
import { getNodeFailureReason, isNodeFailureStatus } from '../../../lib/nodeFailureReason';
import { shouldHydrateAgentRunHover } from '../../../lib/agentRunHoverHydrationPolicy';

// Compact status icon only - no text

const StatusIcon = ({
  status,
  failureReason,
}: {
  status: AgentStatus | null | undefined;
  failureReason: string | null;
}) => {
  if (!status) return null;

  const config = getAgentVisualState(status);
  const Icon = config.icon;
  const title = failureReason ? `Agent ${config.label}: ${failureReason}` : `Agent ${config.label}`;

  return (
    <div
      className={cn(config.colorClass)}
      title={title}
    >
      <Icon size={12} className={cn(config.animate && "animate-spin")} />
    </div>
  );
};

export const GraphAssistantNode = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  focusFeedbackEnabled,
  disableHoverCard,
  detailLevel = 'full',
  heightKey,
  onMeasureHeight,
  hoverCardContent,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const runStatus = useRunStatusStore(state => nodeId ? state.byNodeId[nodeId]?.status ?? null : null);
  const displayStatus = runStatus ?? entity.status;
  const resolvedHoverHydrationEnabled = shouldHydrateAgentRunHover(entity, runStatus);
  const isFullDetail = detailLevel === 'full';
  const isMinimalDetail = detailLevel === 'minimal';
  const assistantIdentityLabel = getAssistantIdentityLabel({
    llmModel: entity.message?.llmModel,
    llmProvider: entity.message?.llmProvider,
  });
  const failureReason = isNodeFailureStatus(displayStatus)
    ? getNodeFailureReason(entity.message?.execution_data)
    : null;

  return (
    <GraphNodeWrapper
      nodeId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      focusFeedbackEnabled={focusFeedbackEnabled}
      disableHoverCard={disableHoverCard}
      heightKey={heightKey}
      className={cn(
        'bg-white/95 border-zinc-200/95 dark:bg-zinc-950/90 dark:border-zinc-800/95',
        'rounded-t-[5px] shadow-[0_10px_26px_-20px_rgba(24,24,27,0.58)]'
      )}
      style={{
        width: 200,
        height: 112,
      }}
      onMeasureHeight={onMeasureHeight}
      hoverCardContent={hoverCardContent}
      hoverHydrationEnabled={resolvedHoverHydrationEnabled}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      {entity.commitCount !== undefined && entity.commitCount > 0 && (
        <div className="absolute right-[-3px] top-1/2 z-10 h-2 w-2 -translate-y-1/2 rounded-full border border-white bg-emerald-500 dark:border-zinc-950" />
      )}

      <div className="relative z-10 mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
            <Bot size={13} strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
              {assistantIdentityLabel}
            </div>
            {entity.shortLabel && (
              <div className="truncate text-[10px] font-medium text-zinc-500 dark:text-zinc-500">
                {entity.shortLabel}
              </div>
            )}
          </div>
        </div>
        <StatusIcon status={displayStatus as any} failureReason={failureReason} />
      </div>

      {isMinimalDetail ? (
        <div className="relative z-10 flex min-h-0 flex-1 items-center">
          <div className="h-1.5 w-full rounded-full bg-zinc-200/70 dark:bg-zinc-800/75" />
        </div>
      ) : (
        <p className={cn(
          'relative z-10 mb-2 flex-1 text-[12px] font-medium leading-snug text-zinc-900 dark:text-zinc-100',
          isFullDetail ? 'line-clamp-2' : 'line-clamp-1',
        )}>
          {entity.preview}
        </p>
      )}

      {isFullDetail && (
      <div className="relative z-10 mt-auto flex items-center gap-3 border-t border-zinc-200/80 pt-1.5 text-[10px] text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-400">
        {entity.toolCallCount !== undefined && entity.toolCallCount > 0 && (
          <div
            className="flex items-center gap-1"
            title={`${entity.toolCallCount} tool calls`}
          >
            <Wrench size={10} className="text-zinc-500" />
            {entity.toolCallCount}
          </div>
        )}
        {entity.commitCount !== undefined && entity.commitCount > 0 && (
          <div
            className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400"
            title={`${entity.commitCount} commits`}
          >
            <GitCommitHorizontal size={10} />
            {entity.commitCount}
          </div>
        )}
        {entity.totalTokens !== undefined && entity.totalTokens !== null && entity.totalTokens > 0 && (
          <div
            className="ml-auto flex items-center gap-1"
            title={`${entity.totalTokens.toLocaleString()} tokens`}
          >
            <Zap size={10} className="text-amber-600" />
            {(entity.totalTokens / 1000).toFixed(1)}k
          </div>
        )}
      </div>
      )}
    </GraphNodeWrapper>
  );
});

GraphAssistantNode.displayName = 'GraphAssistantNode';
