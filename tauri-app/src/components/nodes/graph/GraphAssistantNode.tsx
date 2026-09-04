import { memo, useState } from 'react';
import { Bot, GitCommitHorizontal, Wrench, Zap } from 'lucide-react';
import { isActiveAgentStatus } from '@shared/agentStatus';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import type { AttentionBadgeItem, SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import type { AgentStatus } from '@shared/agentStatus';
import { getAgentVisualState } from '../../../lib/agentStateUI';
import { useRunStatusStore } from '../../../stores/runStatusStore';
import { getAssistantIdentityLabel } from '../../../lib/assistantIdentity';
import { getNodeFailureReason, isNodeFailureStatus } from '../../../lib/nodeFailureReason';
import { shouldHydrateAgentRunHover } from '../../../lib/agentRunHoverHydrationPolicy';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../../@/components/ui/hover-card';

const isActiveAssistantStatus = (status: AgentStatus | null | undefined): boolean => (
  isActiveAgentStatus(status)
);

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

const kindLabel = (kind: string): string => (
  kind
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
);

const AttentionBadge = ({
  count,
  items,
  onHoverChange,
}: {
  count: number;
  items: AttentionBadgeItem[];
  onHoverChange: (active: boolean) => void;
}) => {
  const previewItems = items.slice(0, 5);
  const hiddenCount = Math.max(0, count - previewItems.length);
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(() => new Set());

  const toggleExpanded = (itemId: string) => {
    setExpandedItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  return (
    <HoverCard
      openDelay={120}
      closeDelay={90}
      onOpenChange={onHoverChange}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          data-agentree-attention-badge
          className={cn(
            'app-focus-ring group/attention inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 pr-2',
            'border border-amber-300/72 bg-amber-50/95 text-amber-800',
            'shadow-[0_8px_18px_-14px_rgba(180,83,9,0.72),inset_0_1px_0_rgba(255,255,255,0.78)]',
            'transition-[background-color,border-color,box-shadow,transform] duration-150 active:scale-[0.96]',
            'hover:border-amber-400/80 hover:bg-amber-100',
            'dark:border-amber-400/24 dark:bg-amber-950/48 dark:text-amber-100 dark:hover:border-amber-300/38 dark:hover:bg-amber-900/46',
          )}
          aria-label={`${count} attention ${count === 1 ? 'item' : 'items'} from this turn`}
          onPointerEnter={() => onHoverChange(true)}
          onPointerLeave={() => onHoverChange(false)}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3)] dark:bg-amber-300 dark:text-amber-950">
            <Zap size={9} strokeWidth={2.4} />
          </span>
          <span className="font-mono text-[10px] font-bold leading-none tabular-nums">
            {count > 99 ? '99+' : count}
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="z-[70] w-72 overflow-hidden rounded-2xl border border-slate-200/82 bg-white/96 p-0 shadow-[0_24px_70px_-42px_rgba(15,23,42,0.62),0_10px_28px_-22px_rgba(15,23,42,0.36),inset_0_1px_0_rgba(255,255,255,0.8)] backdrop-blur-xl dark:border-slate-800/88 dark:bg-slate-950/96 dark:shadow-[0_24px_72px_-42px_rgba(0,0,0,0.78),inset_0_1px_0_rgba(255,255,255,0.05)]"
        onPointerEnter={() => onHoverChange(true)}
        onPointerLeave={() => onHoverChange(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="border-b border-slate-200/72 bg-amber-50/76 px-3 py-2.5 dark:border-slate-800/82 dark:bg-amber-950/24">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-950 dark:text-slate-50">
              Attention from this turn
            </div>
            <div className="rounded-full bg-white/80 px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-amber-700 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.2)] dark:bg-slate-950/70 dark:text-amber-200">
              {count}
            </div>
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto overscroll-contain p-2">
          {previewItems.length > 0 ? (
            <div className="space-y-1.5">
              {previewItems.map((item) => {
                const expanded = expandedItemIds.has(item.id);
                const canExpand = item.label.length > 88;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="app-focus-ring w-full rounded-xl border border-slate-200/70 bg-white/82 p-2.5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.68)] transition-[background-color,border-color,box-shadow,transform] duration-150 hover:border-amber-300/62 hover:bg-amber-50/62 active:scale-[0.98] dark:border-slate-800/78 dark:bg-slate-900/56 dark:hover:border-amber-400/28 dark:hover:bg-amber-950/18"
                    aria-expanded={expanded}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleExpanded(item.id);
                    }}
                  >
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-amber-800 dark:bg-amber-400/12 dark:text-amber-200">
                        {kindLabel(item.kind)}
                      </span>
                      {item.status ? (
                        <span className="min-w-0 truncate rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          {item.status}
                        </span>
                      ) : null}
                      <span className="ml-auto text-[9px] font-semibold uppercase tracking-[0.1em] text-slate-400">
                        {expanded ? 'Less' : canExpand ? 'More' : 'Open'}
                      </span>
                    </div>
                    <p className={cn(
                      'text-[11px] font-medium leading-4 text-slate-800 dark:text-slate-100',
                      expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2',
                    )}>
                      {item.label}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-3 py-5 text-center text-xs text-slate-500 dark:text-slate-400">
              Attention details unavailable.
            </div>
          )}
          {hiddenCount > 0 ? (
            <div className="mt-2 rounded-xl bg-slate-100/72 px-3 py-2 text-[11px] font-medium text-slate-500 dark:bg-slate-900/70 dark:text-slate-400">
              +{hiddenCount} more in the inbox
            </div>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};

export const GraphAssistantNode = memo(({
  nodeId,
  entity,
  isFocused,
  isSelected,
  focusFeedbackEnabled,
  disableHoverCard,
  attentionBadgeCount,
  attentionBadgeItems = [],
  detailLevel = 'full',
  heightKey,
  onMeasureHeight,
  hoverCardContent,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const [attentionHoverActive, setAttentionHoverActive] = useState(false);
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
  const isAssistantWorking = isActiveAssistantStatus(displayStatus as AgentStatus | null | undefined);
  const hasAttention = Boolean(attentionBadgeCount && attentionBadgeCount > 0);

  return (
    <GraphNodeWrapper
      nodeId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      focusFeedbackEnabled={focusFeedbackEnabled}
      disableHoverCard={disableHoverCard || attentionHoverActive}
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
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {hasAttention ? (
            <AttentionBadge
              count={attentionBadgeCount ?? 0}
              items={attentionBadgeItems}
              onHoverChange={setAttentionHoverActive}
            />
          ) : null}
          <StatusIcon status={displayStatus as any} failureReason={failureReason} />
        </div>
      </div>

      {isMinimalDetail ? (
        <div className="relative z-10 flex min-h-0 flex-1 items-center">
          <div className="h-1.5 w-full rounded-full bg-zinc-200/70 dark:bg-zinc-800/75" />
        </div>
      ) : isAssistantWorking ? (
        <div className={cn(
          'relative z-10 mb-2 flex-1 rounded-md border px-2.5 py-2',
          'border-amber-200/75 bg-amber-50/80 text-amber-950',
          'shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]',
          'dark:border-amber-900/55 dark:bg-amber-950/20 dark:text-amber-100'
        )}>
          <div className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500 dark:bg-amber-400" />
            <span className="min-w-0">
              <span className="block text-[11px] font-semibold leading-tight">
                Assistant is working.
              </span>
              <span className={cn(
                'block text-[10px] font-medium leading-snug text-amber-800/80 dark:text-amber-200/75',
                isFullDetail ? 'line-clamp-2' : 'line-clamp-1'
              )}>
                Please hover to check progress.
              </span>
            </span>
          </div>
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
