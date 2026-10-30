import { memo, useState, type SVGProps } from 'react';
import { Bot, GitBranch, GitCommitHorizontal, Wrench, Zap } from 'lucide-react';
import { isActiveAgentStatus } from '@shared/agentStatus';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import type { AttentionBadgeItem, SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import type { AgentStatus } from '@shared/agentStatus';
import { getAgentVisualState } from '../../../lib/agentStateUI';
import { useRunStatusStore } from '../../../stores/runStatusStore';
import {
  getAssistantIdentityParts,
  getAssistantProviderIconKind,
  getAssistantReasoningEffortFromExecutionData,
} from '../../../lib/assistantIdentity';
import { getNodeFailureReason, isNodeFailureStatus } from '../../../lib/nodeFailureReason';
import { shouldHydrateAgentRunHover } from '../../../lib/agentRunHoverHydrationPolicy';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../../@/components/ui/hover-card';
import { getMessageArtifacts } from '../../../lib/artifacts';
import { ArtifactGraphPreview } from '../../artifacts/ArtifactPreview';
import type { AttachedThreadLink } from '../../../lib/graphSubgraphThreads';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../../@/components/ui/dropdown-menu';

const isActiveAssistantStatus = (status: AgentStatus | null | undefined): boolean => (
  isActiveAgentStatus(status)
);

const CodexIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
    <path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z" />
  </svg>
);

const ClaudeIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
  </svg>
);

const AssistantProviderIcon = ({
  iconKind,
}: {
  iconKind: ReturnType<typeof getAssistantProviderIconKind>;
}) => {
  if (iconKind === 'codex') return <CodexIcon className="h-3.5 w-3.5" />;
  if (iconKind === 'claude') return <ClaudeIcon className="h-3.5 w-3.5" />;
  return <Bot size={13} strokeWidth={1.8} />;
};

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

const stopAttachedThreadEvent = (event: React.SyntheticEvent) => {
  event.stopPropagation();
};

const AttachedThreadStatus = ({
  status,
}: {
  status: AgentStatus | null | undefined;
}) => {
  if (!status) return null;
  const config = getAgentVisualState(status);
  const Icon = config.icon;
  return (
    <span className={cn('shrink-0', config.colorClass)} title={`Thread ${config.label}`}>
      <Icon size={10} className={cn(config.animate && 'animate-spin')} />
    </span>
  );
};

const AttachedThreadButton = ({
  thread,
  compact = false,
  onOpenThread,
}: {
  thread: AttachedThreadLink;
  compact?: boolean;
  onOpenThread: (threadRootId: string) => void;
}) => {
  const liveStatus = useRunStatusStore((state) => (
    thread.statusNodeId ? state.byNodeId[thread.statusNodeId]?.status ?? null : null
  ));
  const status = liveStatus ?? thread.status;

  return (
    <button
      type="button"
      aria-label={`Open attached thread: ${thread.title}`}
      title={thread.title}
      className={cn(
        'nodrag nopan relative flex h-10 min-w-0 items-center gap-1.5 overflow-hidden rounded-[5px] bg-[hsl(var(--app-panel)/0.86)] px-2 text-left',
        'shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.64)]',
        'transition-[background-color,box-shadow,transform] duration-normal ease-out-cubic hover:bg-[hsl(var(--app-accent-soft)/0.42)] active:scale-[0.96] motion-reduce:transition-none',
        'focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]',
        compact && 'justify-center px-1',
      )}
      onPointerDown={stopAttachedThreadEvent}
      onClick={(event) => {
        event.stopPropagation();
        onOpenThread(thread.threadRootId);
      }}
    >
      <GitBranch size={compact ? 10 : 11} className="shrink-0 text-[hsl(var(--app-graph-agent))]" />
      {!compact ? (
        <span className="min-w-0 flex-1 truncate text-[9px] font-medium leading-none text-foreground/80">
          {thread.title}
        </span>
      ) : null}
      <AttachedThreadStatus status={status} />
    </button>
  );
};

const AttachedThreadOverflowItem = ({
  thread,
  onOpenThread,
}: {
  thread: AttachedThreadLink;
  onOpenThread: (threadRootId: string) => void;
}) => {
  const liveStatus = useRunStatusStore((state) => (
    thread.statusNodeId ? state.byNodeId[thread.statusNodeId]?.status ?? null : null
  ));
  return (
    <DropdownMenuItem
      className="min-h-10 cursor-pointer gap-2 rounded-md px-2.5 text-xs"
      onSelect={(event) => {
        event.stopPropagation();
        onOpenThread(thread.threadRootId);
      }}
    >
      <GitBranch size={12} className="shrink-0 text-[hsl(var(--app-graph-agent))]" />
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <AttachedThreadStatus status={liveStatus ?? thread.status} />
    </DropdownMenuItem>
  );
};

const AttachedThreadsTray = ({
  threads,
  onOpenThread,
}: {
  threads: AttachedThreadLink[];
  onOpenThread: (threadRootId: string) => void;
}) => {
  const hasOverflow = threads.length >= 4;
  const visibleThreads = hasOverflow ? threads.slice(0, 3) : threads;
  const overflowThreads = hasOverflow ? threads.slice(3) : [];
  const columnCount = hasOverflow ? 4 : Math.max(1, visibleThreads.length);

  return (
    <div
      className="relative z-20 mt-2 h-14 shrink-0 border-t border-[hsl(var(--app-border)/0.64)] pt-1"
      onPointerDown={stopAttachedThreadEvent}
      onClick={stopAttachedThreadEvent}
    >
      <div data-design-typography="soft-label" className="mb-1 flex h-3 items-center justify-between text-[8px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
        <span>Attached threads</span>
        <span className="tabular-nums">{threads.length}</span>
      </div>
      <div
        className="grid h-10 gap-px rounded-md bg-[hsl(var(--app-border)/0.62)] p-px"
        style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
      >
        {visibleThreads.map((thread) => (
          <AttachedThreadButton
            key={thread.linkMessageId}
            thread={thread}
            compact={hasOverflow}
            onOpenThread={onOpenThread}
          />
        ))}
        {hasOverflow ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Show ${overflowThreads.length} more attached threads`}
                data-design-typography="soft-label"
                className={cn(
                  'nodrag nopan flex h-10 min-w-0 items-center justify-center rounded-[5px] bg-[hsl(var(--app-panel)/0.86)] text-[9px] font-medium text-[hsl(var(--app-graph-agent))]',
                  'shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.64)] tabular-nums',
                  'transition-[background-color,box-shadow,transform] duration-normal ease-out-cubic hover:bg-[hsl(var(--app-accent-soft)/0.42)] active:scale-[0.96] motion-reduce:transition-none',
                  'focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--app-focus))]',
                )}
                onPointerDown={stopAttachedThreadEvent}
                onClick={stopAttachedThreadEvent}
              >
                +{overflowThreads.length}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-60 p-1"
              onPointerDown={stopAttachedThreadEvent}
              onClick={stopAttachedThreadEvent}
            >
              {overflowThreads.map((thread) => (
                <AttachedThreadOverflowItem
                  key={thread.linkMessageId}
                  thread={thread}
                  onOpenThread={onOpenThread}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
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
            'border border-[hsl(var(--app-warning)/0.34)] bg-[hsl(var(--app-warning)/0.1)] text-[hsl(var(--app-warning))]',
            'shadow-[0_8px_18px_-14px_hsl(var(--app-warning)/0.48),inset_0_1px_0_hsl(var(--foreground)/0.04)]',
            'transition-[background-color,border-color,box-shadow,transform] duration-normal ease-out-cubic active:scale-[0.96] motion-reduce:transition-none',
            'hover:border-[hsl(var(--app-warning)/0.48)] hover:bg-[hsl(var(--app-warning)/0.15)]',
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
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[hsl(var(--app-warning))] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]">
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
        className="z-[70] w-72 overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.78)] bg-[hsl(var(--app-panel)/0.98)] p-0 shadow-[0_24px_64px_-38px_hsl(var(--foreground)/0.5),inset_0_1px_0_hsl(var(--foreground)/0.04)]"
        onPointerEnter={() => onHoverChange(true)}
        onPointerLeave={() => onHoverChange(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="border-b border-[hsl(var(--app-border)/0.64)] bg-[hsl(var(--app-warning)/0.075)] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-foreground">
              Attention from this turn
            </div>
            <div className="rounded-md bg-[hsl(var(--app-panel-strong)/0.82)] px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-[hsl(var(--app-warning))] shadow-[inset_0_0_0_1px_hsl(var(--app-warning)/0.2)]">
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
                    className="app-focus-ring w-full rounded-lg border border-[hsl(var(--app-border)/0.66)] bg-[hsl(var(--app-bg-muted)/0.42)] p-2.5 text-left shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)] transition-[background-color,border-color,box-shadow,transform] duration-normal ease-out-cubic hover:border-[hsl(var(--app-warning)/0.38)] hover:bg-[hsl(var(--app-warning)/0.07)] active:scale-[0.98] motion-reduce:transition-none"
                    aria-expanded={expanded}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleExpanded(item.id);
                    }}
                  >
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <span data-design-typography="soft-label" className="rounded-md bg-[hsl(var(--app-warning)/0.12)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.1em] text-[hsl(var(--app-warning))]">
                        {kindLabel(item.kind)}
                      </span>
                      {item.status ? (
                        <span className="min-w-0 truncate rounded-md bg-[hsl(var(--app-bg-muted)/0.76)] px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                          {item.status}
                        </span>
                      ) : null}
                      <span data-design-typography="soft-label" className="ml-auto text-[9px] font-medium uppercase tracking-[0.1em] text-muted-foreground/70">
                        {expanded ? 'Less' : canExpand ? 'More' : 'Open'}
                      </span>
                    </div>
                    <p className={cn(
                      'text-[11px] font-medium leading-4 text-foreground',
                      expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2',
                    )}>
                      {item.label}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-3 py-5 text-center text-xs text-muted-foreground">
              Attention details unavailable.
            </div>
          )}
          {hiddenCount > 0 ? (
            <div className="mt-2 rounded-lg bg-[hsl(var(--app-bg-muted)/0.68)] px-3 py-2 text-[11px] font-medium text-muted-foreground">
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
  graphNodeHeight,
  heightKey,
  attachedThreads = [],
  onMeasureHeight,
  hoverCardContent,
  controlledHoverCardKey,
  onControlledHoverCardDismiss,
  onFocus,
  onOpenThread,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const [attentionHoverActive, setAttentionHoverActive] = useState(false);
  const runStatus = useRunStatusStore(state => nodeId ? state.byNodeId[nodeId]?.status ?? null : null);
  const displayStatus = runStatus ?? entity.status;
  const resolvedHoverHydrationEnabled = shouldHydrateAgentRunHover(entity, runStatus);
  const isFullDetail = detailLevel === 'full';
  const isMinimalDetail = detailLevel === 'minimal';
  const cardHeight = typeof graphNodeHeight === 'number' ? graphNodeHeight : 112;
  const { label: assistantIdentityLabel, reasoningEffort: assistantReasoningEffortLabel } = getAssistantIdentityParts({
    llmModel: entity.message?.llmModel,
    llmProvider: entity.message?.llmProvider,
    reasoningEffort: getAssistantReasoningEffortFromExecutionData(entity.message?.execution_data),
  });
  const assistantIconKind = getAssistantProviderIconKind({
    llmModel: entity.message?.llmModel,
    llmProvider: entity.message?.llmProvider,
  });
  const failureReason = isNodeFailureStatus(displayStatus)
    ? getNodeFailureReason(entity.message?.execution_data, entity.preview)
    : null;
  const isAssistantWorking = isActiveAssistantStatus(displayStatus as AgentStatus | null | undefined);
  const hasAttention = Boolean(attentionBadgeCount && attentionBadgeCount > 0);
  const outputArtifacts = getMessageArtifacts(entity.message, { includeAttachments: false, role: 'output' })
    .filter((artifact) => artifact.role === 'output');
  const hasOutputArtifacts = outputArtifacts.length > 0;
  return (
    <GraphNodeWrapper
      nodeId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      focusFeedbackEnabled={focusFeedbackEnabled}
      disableHoverCard={disableHoverCard || attentionHoverActive}
      heightKey={heightKey}
      className={cn(
        'border-[hsl(var(--app-border)/0.8)] bg-[hsl(var(--app-panel)/0.95)]',
        'rounded-t-[5px] shadow-[0_10px_26px_-20px_hsl(var(--foreground)/0.32)]'
      )}
      style={{
        width: 200,
        height: cardHeight,
      }}
      onMeasureHeight={onMeasureHeight}
      hoverCardContent={hoverCardContent}
      hoverHydrationEnabled={resolvedHoverHydrationEnabled}
      controlledHoverCardKey={controlledHoverCardKey}
      onControlledHoverCardDismiss={onControlledHoverCardDismiss}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      {entity.commitCount !== undefined && entity.commitCount > 0 && (
        <div className="absolute right-[-3px] top-1/2 z-10 h-2 w-2 -translate-y-1/2 rounded-full border border-[hsl(var(--app-panel))] bg-[hsl(var(--app-graph-commit))]" />
      )}

      <div className="relative z-10 mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-bg-muted)/0.62)] text-foreground/80"
            title={`${assistantIdentityLabel} icon`}
            aria-label={`${assistantIconKind === 'generic' ? 'Assistant' : assistantIconKind === 'codex' ? 'Codex' : assistantIconKind === 'opencode' ? 'OpenCode' : 'Claude'} icon`}
          >
            <AssistantProviderIcon iconKind={assistantIconKind} />
          </div>
          <div className="min-w-0">
            <div data-design-typography="soft-label" className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {assistantIdentityLabel}
              {assistantReasoningEffortLabel && (
                <span className="ml-1 normal-case">{assistantReasoningEffortLabel}</span>
              )}
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

      {!isMinimalDetail && !isAssistantWorking && hasOutputArtifacts ? (
        <ArtifactGraphPreview artifacts={outputArtifacts} />
      ) : null}

      {isMinimalDetail ? (
        <div className="relative z-10 flex min-h-0 flex-1 items-center">
          <div className="h-1.5 w-full rounded-full bg-[hsl(var(--app-border)/0.58)]" />
        </div>
      ) : isAssistantWorking ? (
        <div className={cn(
          'relative z-10 mb-2 flex-1 rounded-md border px-2.5 py-2',
          'border-[hsl(var(--app-warning)/0.28)] bg-[hsl(var(--app-warning)/0.08)] text-foreground',
          'shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]'
        )}>
          <div className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[hsl(var(--app-warning))] motion-reduce:animate-none" />
            <span className="min-w-0">
              <span data-design-typography="soft-body" className="block text-[11px] font-medium leading-tight">
                Assistant is working.
              </span>
              <span className={cn(
                'block text-[10px] font-medium leading-snug text-muted-foreground',
                isFullDetail ? 'line-clamp-2' : 'line-clamp-1'
              )}>
                Please hover to check progress.
              </span>
            </span>
          </div>
        </div>
      ) : (
        <p className={cn(
          'relative z-10 mb-2 flex-1 text-[12px] font-medium leading-snug text-foreground',
          isFullDetail ? 'line-clamp-2' : 'line-clamp-1',
        )}>
          {failureReason ?? entity.preview}
        </p>
      )}

      {isFullDetail && (
      <div className="relative z-10 mt-auto flex items-center gap-3 border-t border-[hsl(var(--app-border)/0.64)] pt-1.5 text-[10px] text-muted-foreground">
        {entity.toolCallCount !== undefined && entity.toolCallCount > 0 && (
          <div
            className="flex items-center gap-1"
            title={`${entity.toolCallCount} tool calls`}
          >
            <Wrench size={10} className="text-muted-foreground" />
            {entity.toolCallCount}
          </div>
        )}
        {entity.commitCount !== undefined && entity.commitCount > 0 && (
          <div
            className="flex items-center gap-1 text-[hsl(var(--app-graph-commit))]"
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
            <Zap size={10} className="text-[hsl(var(--app-warning))]" />
            {(entity.totalTokens / 1000).toFixed(1)}k
          </div>
        )}
      </div>
      )}
      {attachedThreads.length > 0 && onOpenThread ? (
        <AttachedThreadsTray threads={attachedThreads} onOpenThread={onOpenThread} />
      ) : null}
    </GraphNodeWrapper>
  );
});

GraphAssistantNode.displayName = 'GraphAssistantNode';
