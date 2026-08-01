import { memo } from 'react';
import { Wrench, Layers, Zap } from 'lucide-react';
import { GraphNodeWrapper } from './GraphNodeWrapper';
import { SharedNodeProps } from '../../../types/nodes';
import { cn } from '../../../lib/utils';
import { ROLE_COLORS, withHexAlpha } from '../../../lib/visualTokens';
import type { AgentStatus } from '@shared/agentStatus';
import { getAgentVisualState } from '../../../lib/agentStateUI';
import { useRunStatusStore } from '../../../stores/runStatusStore';

// Compact status icon only - no text

const StatusIcon = ({ status }: { status: AgentStatus | null | undefined }) => {
  if (!status) return null;

  const config = getAgentVisualState(status);
  const Icon = config.icon;

  return (
    <div
      className={cn(config.colorClass)}
      title={`Agent ${config.label}`}
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
  disableHoverCard,
  scopeColor,
  heightKey,
  onMeasureHeight,
  hoverCardContent,
  onFocus,
  onSelect,
  onContextMenu,
}: SharedNodeProps) => {
  const runStatus = useRunStatusStore(state => nodeId ? state.byNodeId[nodeId]?.status ?? null : null);
  const displayStatus = runStatus ?? entity.status;

  return (
    <GraphNodeWrapper
      nodeId={nodeId}
      isFocused={isFocused}
      isSelected={isSelected}
      disableHoverCard={disableHoverCard}
      scopeColor={null} // We handle scope color internally for Assistant nodes
      heightKey={heightKey}
      className={cn(
        ROLE_COLORS.assistant_message.bg,
        ROLE_COLORS.assistant_message.border
      )}
      style={{
        width: 220,
        minHeight: 80,
        backgroundColor: scopeColor ? withHexAlpha(scopeColor, '15') : undefined,
      }}
      onMeasureHeight={onMeasureHeight}
      hoverCardContent={hoverCardContent}
      onFocus={onFocus}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    >
      {/* Vertical line for scope */}
      {scopeColor && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1.5 z-10"
          style={{ backgroundColor: scopeColor }}
        />
      )}

      {/* Header: Status */}
      <div className="flex items-center gap-2 mb-1.5 pt-1 relative z-10">
        <StatusIcon status={displayStatus as any} />
      </div>

      {/* Preview - takes most space */}
      <p className={cn("text-sm font-medium line-clamp-2 leading-relaxed mb-2 flex-1 relative z-10", ROLE_COLORS.assistant_message.text)}>
        {entity.preview}
      </p>

      {/* Metrics - Icon only, compact */}
      <div className="flex items-center gap-3 mt-auto pt-1.5 border-t border-sky-200/50 dark:border-sky-800/50 relative z-10">
        {entity.toolCallCount !== undefined && entity.toolCallCount > 0 && (
          <div
            className="flex items-center gap-1 text-[10px] text-slate-500"
            title={`${entity.toolCallCount} tool calls`}
          >
            <Wrench size={10} className="text-sky-500" />
            {entity.toolCallCount}
          </div>
        )}
        {entity.commitCount !== undefined && entity.commitCount > 0 && (
          <div
            className="flex items-center gap-1 text-[10px] text-slate-500"
            title={`${entity.commitCount} commits`}
          >
            <Layers size={10} className="text-emerald-500" />
            {entity.commitCount}
          </div>
        )}
        {entity.totalTokens !== undefined && entity.totalTokens !== null && entity.totalTokens > 0 && (
          <div
            className="flex items-center gap-1 text-[10px] text-slate-500 ml-auto"
            title={`${entity.totalTokens.toLocaleString()} tokens`}
          >
            <Zap size={10} className="text-amber-500" />
            {(entity.totalTokens / 1000).toFixed(1)}k
          </div>
        )}
      </div>
    </GraphNodeWrapper>
  );
});

GraphAssistantNode.displayName = 'GraphAssistantNode';
