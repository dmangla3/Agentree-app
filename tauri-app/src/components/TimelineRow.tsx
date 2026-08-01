import { useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/utils';
import { Message, BranchPointer, Summary } from '../stores/workspaceStore';
import { getLlmColor, getModelNameById } from '../lib/graphUtils';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { useModels } from '../hooks/useModels';
import { 
  CheckCircle2, 
  Square, 
  Cpu, 
  Zap,
  Tag,
  Layers,
  MoreHorizontal,
  AlertCircle,
  MinusCircle,
  GitCommit,
  GitBranch,
  Copy,
  Check,
    GitCommitHorizontal,
    AlignLeft,
} from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import { Checkbox } from '../../@/components/ui/checkbox';
import type { ExternalCommitGroup } from './TimelineView';
import { getNodePreview, getToolCallCount } from '../domain/nodes';
import { CopyCommitShaButton } from './CopyCommitShaButton';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';

// Helper: Check if a message is an external commit
const isExternalCommit = (msg: Message): boolean => {
  if (msg.role !== 'assistant') return false;
  const executionData = msg.execution_data as Record<string, unknown> | undefined;
  return (executionData?.meta as Record<string, unknown>)?.sync_source === 'external_git';
};

// Helper: Check if a message is a first-class commit node
const isFirstClassCommitMessage = (msg: Message): boolean => {
  if (msg.role !== 'assistant') return false;
  const nodeKind = (msg as any)?.node_kind ?? (msg as any)?.nodeKind;
  if (nodeKind === 'commit' || nodeKind === 'commit_batch') return true;
  if (isExternalCommit(msg)) return true;
  return Boolean(msg.commit?.sha);
};

type TimelineRowType = 'message' | 'external-commit-group' | 'summary';

interface TimelineRowBaseProps {
  type: TimelineRowType;
  isFocused: boolean;
  matchesTagFilter: boolean;
  onNodeClick: (event: React.MouseEvent, messageId: string) => void;
  isFirstOfMonth: boolean;
  isLastOfMonth: boolean;
  scopeName?: string | null;
  isScopeBoundary?: boolean;
  isRunning?: boolean;
  onStopAgent?: (nodeId: string) => void;
  selectionModeActive?: boolean;
  isSelected?: boolean;
  onSelectionToggle?: (messageId: string, checked: boolean) => void;
  focusedMessageId?: string | null;
  matchingMessageIds?: Set<string>;
  selectedNodeIds?: Set<string>;
}

interface MessageTimelineRowProps extends TimelineRowBaseProps {
  type: 'message';
  message: Message;
}

interface ExternalCommitGroupTimelineRowProps extends TimelineRowBaseProps {
  type: 'external-commit-group';
  commitGroup: ExternalCommitGroup;
}

interface SummaryTimelineRowProps extends TimelineRowBaseProps {
  type: 'summary';
  summary: Summary;
}

type TimelineRowProps = MessageTimelineRowProps | ExternalCommitGroupTimelineRowProps | SummaryTimelineRowProps;

export function TimelineRow(props: TimelineRowProps) {
  if (props.type === 'external-commit-group') {
    return (
      <ExternalCommitGroupRow
        commitGroup={props.commitGroup}
        isFocused={props.isFocused}
        matchesTagFilter={props.matchesTagFilter}
        onNodeClick={props.onNodeClick}
        isFirstOfMonth={props.isFirstOfMonth}
        isLastOfMonth={props.isLastOfMonth}
        selectionModeActive={props.selectionModeActive}
        isSelected={props.isSelected}
        onSelectionToggle={props.onSelectionToggle}
        focusedMessageId={props.focusedMessageId}
        matchingMessageIds={props.matchingMessageIds}
        selectedNodeIds={props.selectedNodeIds}
      />
    );
  }

  if (props.type === 'summary') {
    return <SummaryTimelineRow {...props} />;
  }

  return <MessageTimelineRow {...props} />;
}

function MessageTimelineRow(props: MessageTimelineRowProps) {
  const {
    isFocused,
    matchesTagFilter,
    onNodeClick,
    isFirstOfMonth,
    scopeName = null,
    isScopeBoundary = false,
    isRunning = false,
    onStopAgent,
    selectionModeActive = false,
    isSelected = false,
    onSelectionToggle,
  } = props;

  const [timeTick, setTimeTick] = useState(() => Date.now());

  const { data: allModelsData } = useModels();
  const allModels = useMemo(() => allModelsData ?? [], [allModelsData]);

  const { message } = props;
  const isCommit = isFirstClassCommitMessage(message);
  const isExternal = isExternalCommit(message);
  const isAgentNode = !!message.agent_id || !!message.status;
  const isUserMessage = message.role === 'user';
  const isVisible = matchesTagFilter || isFocused;
  const toolCallCount = getToolCallCount(message);
  const commitCount = typeof (message.execution_data as any)?.commit_count === 'number'
    ? (message.execution_data as any).commit_count
    : undefined;

  useEffect(() => {
    if (!isAgentNode) return;

    const shouldTick = isRunning || message.status === 'completed' || message.status === 'failed' || message.status === 'error' || message.status === 'cancelled';
    if (!shouldTick) return;

    const intervalId = window.setInterval(() => {
      setTimeTick(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isAgentNode, isRunning, message.status]);

  // For agent-created commits, render as indented child row
  if (isCommit && !isExternal) {
    return (
      <AgentCommitRow
        message={message}
        isFocused={isFocused}
        matchesTagFilter={matchesTagFilter}
        onNodeClick={onNodeClick}
        isFirstOfMonth={isFirstOfMonth}
        selectionModeActive={selectionModeActive}
        isSelected={isSelected}
        onSelectionToggle={onSelectionToggle}
      />
    );
  }

  // Row Click Handler
  const handleRowClick = (event: React.MouseEvent) => {
    console.log(`[TimelineRow] Clicked row for message ${message.id}. IsVisible: ${isVisible}`);
    if (isVisible) {
      console.log(`[TimelineRow] Calling onNodeClick for message ${message.id}`);
      onNodeClick(event, message.id);
    } else {
      console.log(`[TimelineRow] Click ignored because row is not visible (filtered out & not focused).`);
    }
  };

  // Use AI label if available, otherwise fall back to truncated content
  const displayTitle = getNodePreview(message).slice(0, 100);

  const startedAt = new Date(message.createdAt);
  const completedAt = new Date(message.last_event_at ?? message.updatedAt ?? message.createdAt);
  const formattedTime = format(startedAt, 'h:mm a');
  const llmName = isUserMessage ? 'User' : getModelNameById(message.llmModel, allModels);
  const llmColor = getLlmColor(message.llmModel);
  const elapsedMs = Math.max(0, timeTick - startedAt.getTime());
  const formattedElapsed = formatElapsed(elapsedMs);
  const timeLabel = isAgentNode
    ? isRunning
      ? formattedElapsed
      : message.status === 'completed' || message.status === 'failed' || message.status === 'error' || message.status === 'cancelled'
        ? `done ${formatDistanceToNowStrict(completedAt, { addSuffix: true })}`
        : formattedTime
    : formattedTime;
  const showStopButton = isAgentNode && isRunning && !!onStopAgent;

  const statusMeta = getStatusMeta(message.status, isRunning);

  const handleStopClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onStopAgent?.(message.id);
  };

  // Extract git metadata
  const outputCommitSha = getMessageOutputCommitSha(message);
  const hasGitData = outputCommitSha || (message.branchPointers && message.branchPointers.length > 0);
  
  return (
    // Row click handler attached here
    <div
      className={cn(
        "timeline-row flex items-start gap-3 pl-3 pr-4 py-2.5 relative transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 ease-out mb-1 group/row",
        !isVisible && "opacity-20 pointer-events-none grayscale",
        isFocused && [
          "bg-gradient-to-r from-primary/8 via-primary/5 to-transparent",
          "dark:from-primary/15 dark:via-primary/10 dark:to-transparent",
          "rounded-lg shadow-sm border-l-2 border-primary",
          "ring-1 ring-primary/10 dark:ring-primary/20"
        ],
        isSelected && [
          "bg-gradient-to-r from-sky-100 via-sky-50 to-transparent",
          "dark:from-sky-950/40 dark:via-sky-950/20 dark:to-transparent",
          "border-sky-300/80 shadow-[0_8px_24px_rgba(14,165,233,0.10)]",
          "ring-1 ring-sky-300/60"
        ],
        isVisible && !isFocused && [
          "cursor-pointer hover:bg-gradient-to-r hover:from-accent/40 hover:via-accent/20 hover:to-transparent",
          "dark:hover:from-accent/20 dark:hover:via-accent/10 dark:hover:to-transparent",
          "hover:shadow-sm hover:translate-x-0.5"
        ],
        "rounded-lg border border-transparent",
        !isFocused && "hover:border-border/50"
      )}
      onClick={handleRowClick}
    >
      {selectionModeActive && (
        <div className="flex w-8 flex-shrink-0 items-center justify-center pt-0.5">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-sky-50 active:scale-[0.96]"
            onClick={(event) => {
              event.stopPropagation();
              onSelectionToggle?.(message.id, !isSelected);
            }}
            aria-label={isSelected ? 'Deselect row' : 'Select row'}
          >
            <Checkbox checked={isSelected} className="pointer-events-none data-[state=checked]:border-sky-500 data-[state=checked]:bg-sky-500" />
          </button>
        </div>
      )}

      {/* Elegant Timeline Connector */}
      <div
        className={cn(
          selectionModeActive ? "absolute left-[74px] top-0 bottom-0 w-[2px] -z-10" : "absolute left-[42px] top-0 bottom-0 w-[2px] -z-10",
          "bg-gradient-to-b from-border via-border/60 to-border/30"
        )}
      >
        {!isFirstOfMonth && (
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-border/40 to-transparent" />
        )}
      </div>

      {/* 1. Time Column - Elegant monospace timing */}
      <div className="w-[68px] text-right flex-shrink-0">
        <div className={cn(
          "font-mono tabular-nums text-[11px] tracking-tight transition-colors",
          isRunning 
            ? "text-emerald-600 dark:text-emerald-400 font-medium" 
            : "text-muted-foreground/70 group-hover/row:text-muted-foreground"
        )}>
          {timeLabel}
        </div>
        {message.totalTokens !== null && message.totalTokens !== undefined && (
          <div className="text-[9px] text-muted-foreground/50 font-mono tabular-nums mt-0.5 flex items-center justify-end gap-0.5">
            <Zap size={8} className="opacity-60" />
            {message.totalTokens.toLocaleString()}
          </div>
        )}
      </div>

      {/* 2. Modern Status Indicator - Diamond shape for elegance */}
      <div className="flex-shrink-0 pt-1 relative z-[1]">
        <div
          className={cn(
            "w-2.5 h-2.5 rotate-45 transition-[transform,box-shadow,opacity] duration-300 ease-out",
            llmColor,
            isFocused && [
              "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
              "scale-110 shadow-sm"
            ],
            isVisible && "group-hover/row:scale-125 group-hover/row:rotate-45",
            isRunning && "animate-pulse"
          )}
          style={{ borderRadius: '2px' }}
        />
        {/* Glow effect for focused state */}
        {isFocused && (
          <div className={cn(
            "absolute inset-0 w-2.5 h-2.5 rotate-45 blur-sm -z-10",
            llmColor,
            "opacity-50"
          )} style={{ borderRadius: '2px' }} />
        )}
      </div>

      {/* 3. Content Column - Refined typography and layout */}
      <div className="flex-1 min-w-0 pt-0">
        {/* Title with improved typography */}
        <p className={cn(
          "font-medium text-sm leading-snug tracking-tight",
          "transition-colors duration-200",
          isFocused 
            ? "text-foreground dark:text-foreground" 
            : "text-foreground/90 dark:text-foreground/90",
          "group-hover/row:text-foreground"
        )}>
          {displayTitle || (
            <span className="italic text-muted-foreground/60 flex items-center gap-1.5">
              <MoreHorizontal size={12} className="opacity-50" />
              No content
            </span>
          )}
        </p>

        {/* Metadata row with refined badges */}
        <div className="flex items-center justify-between mt-1.5">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className={cn(
              "inline-flex items-center gap-1 text-[10px] text-muted-foreground/80",
              "transition-colors group-hover/row:text-muted-foreground"
            )}>
              <Cpu size={10} className="opacity-60" />
              <span className="truncate max-w-[100px]">{llmName}</span>
            </span>

            {/* Status badge - modern pill design */}
            {statusMeta && (
              <span className={cn(
                "inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full",
                "border shadow-sm",
                statusMeta.badgeClassName
              )}>
                {statusMeta.icon}
                <span>{statusMeta.label}</span>
              </span>
            )}

            {toolCallCount ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200/70 bg-amber-50/70 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                <Tag size={9} className="opacity-70" />
                {toolCallCount} tool{toolCallCount === 1 ? '' : 's'}
              </span>
            ) : null}

            {message.totalTokens ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-200/70 bg-slate-50/70 px-2 py-0.5 text-[10px] font-medium text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
                <Zap size={9} className="opacity-70" />
                {message.totalTokens.toLocaleString()}
              </span>
            ) : null}

            {commitCount ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-blue-200/70 bg-blue-50/70 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
                <GitCommit size={9} className="opacity-70" />
                {commitCount} commit{commitCount === 1 ? '' : 's'}
              </span>
            ) : null}

            {/* Git metadata - compact inline display */}
            {hasGitData && (
              <GitMetaCompact 
                commitSha={outputCommitSha}
                branchPointers={message.branchPointers}
              />
            )}
          </div>

          {/* Right side metadata */}
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70 shrink-0">
            {showStopButton && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "h-6 px-2 text-[10px] text-destructive hover:text-destructive-foreground",
                  "hover:bg-destructive/10 rounded-md transition-[background-color,color,box-shadow]"
                )}
                onClick={handleStopClick}
              >
                <Square size={9} className="mr-1 fill-current" />
                Stop
              </Button>
            )}
            
            {isScopeBoundary && (
              <span className={cn(
                "inline-flex items-center gap-1 text-[10px]",
                "px-1.5 py-0.5 rounded-md border bg-muted/50"
              )}>
                <Layers size={9} className="opacity-60" />
                {scopeName || 'unscoped'}
              </span>
            )}
            
            {message.tags && message.tags.length > 0 && (
              <span className={cn(
                "inline-flex items-center gap-1 text-[10px]",
                "px-1.5 py-0.5 rounded-md bg-secondary/60"
              )}>
                <Tag size={9} className="opacity-60" />
                {message.tags.length}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryTimelineRow({
  summary,
  isFocused,
  matchesTagFilter,
  onNodeClick,
  isFirstOfMonth,
  selectionModeActive = false,
  isSelected = false,
  onSelectionToggle,
}: SummaryTimelineRowProps) {
  const isVisible = matchesTagFilter || isFocused;
  const createdAt = new Date(summary.createdAt);
  const formattedTime = format(createdAt, 'h:mm a');
  const preview = summary.content.replace(/\s+/g, ' ').trim();
  const displayTitle = preview.length > 140 ? `${preview.slice(0, 137)}...` : preview;
  const coveredLabel = summary.startMessageId === summary.endMessageId
    ? '1 node'
    : `${summary.startMessageId.slice(0, 6)} -> ${summary.endMessageId.slice(0, 6)}`;

  const handleClick = (event: React.MouseEvent) => {
    if (!isVisible) return;
    onNodeClick(event, summary.id);
  };

  return (
    <div
      className={cn(
        "timeline-row relative mb-1 flex items-start gap-3 rounded-lg border border-transparent pl-3 pr-4 py-2.5 transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 ease-out group/row",
        !isVisible && "pointer-events-none opacity-20 grayscale",
        isFocused && [
          "rounded-lg border-l-2 border-primary bg-gradient-to-r from-primary/8 via-primary/5 to-transparent shadow-sm",
          "ring-1 ring-primary/10 dark:from-primary/15 dark:via-primary/10 dark:to-transparent dark:ring-primary/20"
        ],
        isSelected && [
          "border-sky-300/80 bg-gradient-to-r from-sky-100 via-sky-50 to-transparent shadow-[0_8px_24px_rgba(14,165,233,0.10)]",
          "ring-1 ring-sky-300/60 dark:from-sky-950/40 dark:via-sky-950/20 dark:to-transparent"
        ],
        isVisible && !isFocused && [
          "cursor-pointer hover:border-border/50 hover:bg-gradient-to-r hover:from-accent/40 hover:via-accent/20 hover:to-transparent hover:shadow-sm hover:translate-x-0.5",
          "dark:hover:from-accent/20 dark:hover:via-accent/10 dark:hover:to-transparent"
        ]
      )}
      onClick={handleClick}
    >
      {selectionModeActive && (
        <div className="flex w-8 flex-shrink-0 items-center justify-center pt-0.5">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-sky-50 active:scale-[0.96]"
            onClick={(event) => {
              event.stopPropagation();
              onSelectionToggle?.(summary.id, !isSelected);
            }}
            aria-label={isSelected ? 'Deselect summary' : 'Select summary'}
          >
            <Checkbox checked={isSelected} className="pointer-events-none data-[state=checked]:border-sky-500 data-[state=checked]:bg-sky-500" />
          </button>
        </div>
      )}

      <div
        className={cn(
          selectionModeActive ? "absolute left-[74px] top-0 bottom-0 w-[2px] -z-10" : "absolute left-[42px] top-0 bottom-0 w-[2px] -z-10",
          "bg-gradient-to-b from-border via-border/60 to-border/30"
        )}
      >
        {!isFirstOfMonth && (
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-border/40 to-transparent" />
        )}
      </div>

      <div className="w-[68px] flex-shrink-0 text-right">
        <div className="font-mono text-[11px] tracking-tight text-muted-foreground/70 tabular-nums group-hover/row:text-muted-foreground">
          {formattedTime}
        </div>
      </div>

      <div className="relative z-[1] flex-shrink-0 pt-1">
        <div
          className={cn(
            "h-2.5 w-2.5 rotate-45 rounded-[2px] bg-gradient-to-br from-violet-400 to-fuchsia-500 transition-all duration-300",
            isFocused && "scale-110 ring-2 ring-primary/40 ring-offset-2 ring-offset-background shadow-sm",
            isVisible && "group-hover/row:scale-125"
          )}
        />
      </div>

      <div className="min-w-0 flex-1 pt-0">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-medium leading-snug tracking-tight text-foreground/90 transition-colors duration-200 group-hover/row:text-foreground">
            {displayTitle || (
              <span className="flex items-center gap-1.5 italic text-muted-foreground/60">
                <AlignLeft size={12} className="opacity-50" />
                Empty summary
              </span>
            )}
          </p>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-violet-200/70 bg-violet-50/80 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-300">
            <AlignLeft size={9} className="opacity-70" />
            Summary
          </span>
        </div>

        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/75">
          <span className="inline-flex items-center gap-1">
            <Layers size={10} className="opacity-60" />
            {coveredLabel}
          </span>
          {summary.tokenCountBefore != null && summary.tokenCountAfter != null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200/70 bg-slate-50/70 px-2 py-0.5 font-medium text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300">
              <Zap size={9} className="opacity-70" />
              {summary.tokenCountBefore.toLocaleString()} {'->'} {summary.tokenCountAfter.toLocaleString()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function getStatusMeta(status: Message['status'], isRunning: boolean) {
  if (!status && !isRunning) return null;

  if (isRunning || status === 'running' || status === 'streaming') {
    return {
      label: 'Running',
      className: 'text-emerald-600 dark:text-emerald-400',
      badgeClassName: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400',
      icon: <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
      </span>,
    };
  }

  if (status === 'completed') {
    return {
      label: 'Done',
      className: 'text-emerald-600 dark:text-emerald-400',
      badgeClassName: 'bg-emerald-50/50 dark:bg-emerald-950/30 border-emerald-200/70 dark:border-emerald-800/70 text-emerald-700 dark:text-emerald-400',
      icon: <CheckCircle2 size={11} aria-hidden="true" className="opacity-80" />,
    };
  }

  if (status === 'failed' || status === 'error') {
    return {
      label: 'Error',
      className: 'text-red-600 dark:text-red-400',
      badgeClassName: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400',
      icon: <AlertCircle size={11} aria-hidden="true" className="opacity-80" />,
    };
  }

  if (status === 'cancelled') {
    return {
      label: 'Stopped',
      className: 'text-slate-500 dark:text-slate-400',
      badgeClassName: 'bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400',
      icon: <MinusCircle size={11} aria-hidden="true" className="opacity-80" />,
    };
  }

  return null;
}

// Agent-created Commit Row Component (indented child row)
interface AgentCommitRowProps {
  message: Message;
  isFocused: boolean;
  matchesTagFilter: boolean;
  onNodeClick: (event: React.MouseEvent, messageId: string) => void;
  isFirstOfMonth: boolean;
  selectionModeActive?: boolean;
  isSelected?: boolean;
  onSelectionToggle?: (messageId: string, checked: boolean) => void;
}

function AgentCommitRow({
  message,
  isFocused,
  matchesTagFilter,
  onNodeClick,
  isFirstOfMonth,
  selectionModeActive,
  isSelected,
  onSelectionToggle,
}: AgentCommitRowProps) {
  const isVisible = matchesTagFilter || isFocused;
  const createdAt = new Date(message.createdAt);
  const formattedTime = format(createdAt, 'h:mm a');
  const commitColor = 'bg-gradient-to-br from-blue-400 to-indigo-500';
  const outputCommitSha = getMessageOutputCommitSha(message);

  const handleClick = (event: React.MouseEvent) => {
    if (!isVisible) return;
    onNodeClick(event, message.id);
  };

  return (
    <div
      className={cn(
        "timeline-row flex items-start gap-3 pl-3 pr-4 py-1.5 relative transition-all duration-200 ease-out mb-1 group/row",
        !isVisible && "opacity-30 pointer-events-none",
        isFocused && [
          "bg-gradient-to-r from-primary/8 via-primary/5 to-transparent",
          "dark:from-primary/15 dark:via-primary/10 dark:to-transparent",
          "rounded-lg shadow-sm border-l-2 border-primary",
          "ring-1 ring-primary/10 dark:ring-primary/20"
        ],
        isSelected && [
          "bg-gradient-to-r from-sky-100 via-sky-50 to-transparent",
          "dark:from-sky-950/40 dark:via-sky-950/20 dark:to-transparent",
          "border-sky-300/80 shadow-[0_8px_24px_rgba(14,165,233,0.10)]",
          "ring-1 ring-sky-300/60"
        ],
        isVisible && !isFocused && [
          "cursor-pointer hover:bg-gradient-to-r hover:from-accent/40 hover:via-accent/20 hover:to-transparent",
          "dark:hover:from-accent/20 dark:hover:via-accent/10 dark:hover:to-transparent",
          "hover:shadow-sm hover:translate-x-0.5"
        ],
        "rounded-lg border border-transparent",
        !isFocused && "hover:border-border/50"
      )}
      onClick={handleClick}
    >
      {selectionModeActive && (
        <div className="flex w-8 flex-shrink-0 items-center justify-center pt-0.5">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-sky-50 active:scale-[0.96]"
            onClick={(event) => {
              event.stopPropagation();
              onSelectionToggle?.(message.id, !isSelected);
            }}
            aria-label={isSelected ? 'Deselect commit' : 'Select commit'}
          >
            <Checkbox checked={isSelected} className="pointer-events-none data-[state=checked]:border-sky-500 data-[state=checked]:bg-sky-500" />
          </button>
        </div>
      )}

      {/* Timeline Connector - indented to show hierarchy */}
      <div
        className={cn(
          selectionModeActive 
            ? "absolute left-[82px] top-0 bottom-0 w-[2px] -z-10" 
            : "absolute left-[50px] top-0 bottom-0 w-[2px] -z-10",
          "bg-gradient-to-b from-border via-border/60 to-border/30"
        )}
      >
        {!isFirstOfMonth && (
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-border/40 to-transparent" />
        )}
      </div>

      {/* 1. Time Column - indented */}
      <div className={cn(
        "text-right flex-shrink-0",
        selectionModeActive ? "w-[60px] ml-8" : "w-[68px] ml-6"
      )}>
        <div className="font-mono tabular-nums text-[11px] tracking-tight text-muted-foreground/70 group-hover/row:text-muted-foreground">
          {formattedTime}
        </div>
      </div>

      {/* 2. Status Indicator - smaller */}
      <div className="flex-shrink-0 pt-1 relative z-[1]">
        <div
          className={cn(
            "w-2 h-2 rotate-45 transition-all duration-300",
            commitColor,
            isFocused && [
              "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
              "scale-110 shadow-sm"
            ],
            isVisible && "group-hover/row:scale-125"
          )}
          style={{ borderRadius: '2px' }}
        />
        {isFocused && (
          <div className={cn(
            "absolute inset-0 w-2 h-2 rotate-45 blur-sm -z-10",
            commitColor,
            "opacity-50"
          )} style={{ borderRadius: '2px' }} />
        )}
      </div>

      {/* 3. Content Column - Single Commit */}
      <div className="flex-1 min-w-0">
        <div className={cn(
          "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs",
          "border transition-all duration-150",
          "bg-blue-50/30 dark:bg-blue-950/10 border-blue-200/50 dark:border-blue-800/50",
          isFocused 
            ? "bg-primary/10 border-primary/30 shadow-sm" 
            : "hover:bg-muted/50 hover:border-border/50"
        )}>
          <GitCommit size={12} className="text-muted-foreground shrink-0" />
          <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-muted-foreground shrink-0">
            {outputCommitSha?.slice(0, 7) || '???????'}
            <CopyCommitShaButton commitSha={outputCommitSha} className="h-3.5 w-3.5" />
          </span>
          <span className="truncate flex-1">
            {message.aiLabel || message.content?.slice(0, 80) || `Commit ${message.id.slice(0, 8)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

// External Commit Group Container Component
interface ExternalCommitGroupRowProps {
  commitGroup: ExternalCommitGroup;
  isFocused: boolean;
  matchesTagFilter: boolean;
  onNodeClick: (event: React.MouseEvent, messageId: string) => void;
  isFirstOfMonth: boolean;
  isLastOfMonth: boolean;
  selectionModeActive?: boolean;
  isSelected?: boolean;
  onSelectionToggle?: (messageId: string, checked: boolean) => void;
  focusedMessageId?: string | null;
  matchingMessageIds?: Set<string>;
  selectedNodeIds?: Set<string>;
}

function ExternalCommitGroupRow({
  commitGroup,
  isFocused,
  matchesTagFilter,
  onNodeClick,
  isFirstOfMonth,
  selectionModeActive,
  isSelected,
  onSelectionToggle,
  focusedMessageId,
  matchingMessageIds,
  selectedNodeIds,
}: ExternalCommitGroupRowProps) {
  const isVisible = matchesTagFilter || isFocused;
  const createdAt = new Date(commitGroup.createdAt);
  const formattedTime = format(createdAt, 'h:mm a');
  const groupColor = 'bg-gradient-to-br from-amber-400 to-orange-500';

  const handleGroupClick = (event: React.MouseEvent) => {
    if (!isVisible) return;
    const targetId = focusedMessageId || commitGroup.representativeMessageId;
    onNodeClick(event, targetId);
  };

  const handleCommitClick = (event: React.MouseEvent, commitId: string) => {
    if (!isVisible) return;
    event.stopPropagation();
    onNodeClick(event, commitId);
  };

  return (
    <div
      className={cn(
        "timeline-row flex items-start gap-3 pl-3 pr-4 py-2.5 relative transition-all duration-200 ease-out mb-2 group/row",
        !isVisible && "opacity-30 pointer-events-none",
        isFocused && [
          "bg-gradient-to-r from-primary/8 via-primary/5 to-transparent",
          "dark:from-primary/15 dark:via-primary/10 dark:to-transparent",
          "rounded-lg shadow-sm border-l-2 border-primary",
          "ring-1 ring-primary/10 dark:ring-primary/20"
        ],
        isSelected && [
          "bg-gradient-to-r from-sky-100 via-sky-50 to-transparent",
          "dark:from-sky-950/40 dark:via-sky-950/20 dark:to-transparent",
          "border-sky-300/80 shadow-[0_8px_24px_rgba(14,165,233,0.10)]",
          "ring-1 ring-sky-300/60"
        ],
        isVisible && !isFocused && [
          "cursor-pointer hover:bg-gradient-to-r hover:from-accent/40 hover:via-accent/20 hover:to-transparent",
          "dark:hover:from-accent/20 dark:hover:via-accent/10 dark:hover:to-transparent",
          "hover:shadow-sm hover:translate-x-0.5"
        ],
        "rounded-lg border border-transparent",
        !isFocused && "hover:border-border/50"
      )}
      onClick={handleGroupClick}
    >
      {selectionModeActive && (
        <div className="flex w-8 flex-shrink-0 items-center justify-center pt-0.5">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-sky-50 active:scale-[0.96]"
            onClick={(event) => {
              event.stopPropagation();
              const anySelected = commitGroup.rows.some((row) => selectedNodeIds?.has(row.id));
              commitGroup.rows.forEach(r => {
                onSelectionToggle?.(r.id, !anySelected);
              });
            }}
            aria-label={isSelected ? 'Deselect group' : 'Select group'}
          >
            <Checkbox checked={isSelected} className="pointer-events-none data-[state=checked]:border-sky-500 data-[state=checked]:bg-sky-500" />
          </button>
        </div>
      )}

      {/* Timeline Connector */}
      <div
        className={cn(
          selectionModeActive ? "absolute left-[74px] top-0 bottom-0 w-[2px] -z-10" : "absolute left-[42px] top-0 bottom-0 w-[2px] -z-10",
          "bg-gradient-to-b from-border via-border/60 to-border/30"
        )}
      >
        {!isFirstOfMonth && (
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-border/40 to-transparent" />
        )}
      </div>

      {/* 1. Time Column */}
      <div className="w-[68px] text-right flex-shrink-0">
        <div className="font-mono tabular-nums text-[11px] tracking-tight text-muted-foreground/70 group-hover/row:text-muted-foreground">
          {formattedTime}
        </div>
        <div className="text-[9px] text-muted-foreground/50 font-mono tabular-nums mt-0.5">
          {commitGroup.rows.length} commits
        </div>
      </div>

      {/* 2. Status Indicator */}
      <div className="flex-shrink-0 pt-1 relative z-[1]">
        <div
          className={cn(
            "w-2.5 h-2.5 rotate-45 transition-all duration-300",
            groupColor,
            isFocused && [
              "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
              "scale-110 shadow-sm"
            ],
            isVisible && "group-hover/row:scale-125"
          )}
          style={{ borderRadius: '2px' }}
        />
        {isFocused && (
          <div className={cn(
            "absolute inset-0 w-2.5 h-2.5 rotate-45 blur-sm -z-10",
            groupColor,
            "opacity-50"
          )} style={{ borderRadius: '2px' }} />
        )}
      </div>

      {/* 3. Content Column - Commit Group Container */}
      <div className="flex-1 min-w-0 relative">
        {/* Group Header */}
        <div className={cn(
          "flex items-center gap-2 mb-2",
          "px-2.5 py-1.5 rounded-lg border",
          "bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800"
        )}>
          <GitCommitHorizontal size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-xs font-medium truncate flex-1 text-amber-800 dark:text-amber-200">
            {commitGroup.title}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300">
            {commitGroup.rows.length}
          </span>
        </div>

        {/* Commit Rows - Scrollable container */}
        <div className={cn(
          "space-y-1 overflow-y-auto custom-scrollbar pr-1",
          commitGroup.rows.length > 5 && "max-h-[200px]"
        )}>
          {commitGroup.rows.map((row) => {
            const rowIsFocused = focusedMessageId === row.id;
            const rowMatchesFilter = matchingMessageIds?.has(row.id) ?? true;
            const rowIsVisible = rowMatchesFilter || rowIsFocused || !matchingMessageIds;
            
            return (
              <div
                key={row.id}
                data-commit-id={row.id}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs",
                  "border transition-all duration-150",
                  rowIsFocused 
                    ? "bg-primary/10 border-primary/30 shadow-sm" 
                    : "bg-muted/30 border-transparent hover:bg-muted/50 hover:border-border/50",
                  !rowIsVisible && "opacity-40"
                )}
                data-selected={selectedNodeIds?.has(row.id) ? 'true' : 'false'}
                onClick={(e) => handleCommitClick(e, row.id)}
              >
                <GitCommit size={12} className="text-muted-foreground shrink-0" />
                <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-muted-foreground shrink-0">
                  {row.commitSha?.slice(0, 7) || '???????'}
                  <CopyCommitShaButton commitSha={row.commitSha} className="h-3.5 w-3.5" />
                </span>
                <span className="truncate flex-1">{row.subject}</span>
                {row.importedFromRef && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-900 text-sky-700 dark:text-sky-300 shrink-0">
                    {row.importedFromRef.replace('refs/heads/', '')}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        
        {/* Scroll indicator */}
        {commitGroup.rows.length > 5 && (
          <div className="absolute bottom-0 left-0 right-1 h-6 pointer-events-none rounded-b-md bg-gradient-to-t from-background/80 to-transparent" />
        )}
      </div>
    </div>
  );
}

// Compact git metadata display component
interface GitMetaCompactProps {
  commitSha?: string | null;
  branchPointers?: BranchPointer[] | null;
}

function GitMetaCompact({ commitSha, branchPointers }: GitMetaCompactProps) {
  const [isCopied, setIsCopied] = useState(false);
  
  const shortSha = commitSha ? commitSha.slice(0, 7) : null;
  const refs = branchPointers ?? [];
  const hasShipPath = refs.some(r => r.is_ship_path);
  const primaryRef = refs[0];
  const extraRefCount = refs.length - 1;

  if (!shortSha && refs.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      {/* Commit SHA - minimal pill */}
      {shortSha && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (commitSha) {
              navigator.clipboard.writeText(commitSha).catch(console.error);
              setIsCopied(true);
              setTimeout(() => setIsCopied(false), 1500);
            }
          }}
          className={cn(
            "inline-flex items-center gap-1 text-[9px] font-mono",
            "px-1.5 py-0.5 rounded-md border",
            "bg-slate-50 dark:bg-slate-900/50",
            "border-slate-200 dark:border-slate-700",
            "text-slate-600 dark:text-slate-400",
            "hover:bg-slate-100 dark:hover:bg-slate-800",
            "hover:border-slate-300 dark:hover:border-slate-600",
            "transition-all duration-150",
            "group/commit"
          )}
          title={commitSha ? `Copy: ${commitSha}` : 'Copy commit SHA'}
        >
          <GitCommit size={9} className="opacity-60" />
          <span>{shortSha}</span>
          <span className="opacity-0 group-hover/commit:opacity-100 transition-opacity">
            {isCopied ? <Check size={8} className="text-emerald-500" /> : <Copy size={8} />}
          </span>
        </button>
      )}

      {/* Branch pointer - styled by type */}
      {primaryRef && (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-[9px] font-mono",
            "px-1.5 py-0.5 rounded-md border truncate max-w-[100px]",
            hasShipPath
              ? "bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400"
              : "bg-sky-50/70 dark:bg-sky-950/30 border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-400"
          )}
          title={refs.map(r => r.name).join(', ')}
        >
          <GitBranch size={9} className="opacity-70 shrink-0" />
          <span className="truncate">{primaryRef.name}</span>
          {extraRefCount > 0 && (
            <span className="opacity-60 shrink-0">+{extraRefCount}</span>
          )}
        </span>
      )}
    </div>
  );
}
