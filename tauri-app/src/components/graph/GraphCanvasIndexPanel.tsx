import { useMemo } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { Node } from '@xyflow/react';
import type { Message } from '../../stores/workspaceStore';
import type { LlmNodeData } from '../../lib/graphUtils';
import { getGraphParentId } from '../../lib/graph/lineage';
import { cn } from '../../lib/utils';

interface GraphCanvasIndexPanelProps {
  isVisible: boolean;
  onToggleVisible: (visible: boolean) => void;
  onPreviewEdgeType: (edgeTypeId: GraphEdgeLegendId) => void;
  onFocusMessage: (messageId: string) => void;
  nodes: Node<any>[];
  messages: Message[];
  agentLabelsById: Map<string, string>;
  scopeNameById: Map<string, string>;
  scopeColorById: Map<string, string | null>;
}

const EDGE_LEGEND = [
  {
    id: 'focus-path',
    label: 'Focus Path',
    description: 'The actively emphasized route through the graph. It shows the branch or selection path the rest of the interface is currently anchored to.',
    color: '#4338ca',
    darkColor: '#6366f1',
    width: 2,
    dashed: false,
    opacity: 1,
  },
  {
    id: 'lineage',
    label: 'Lineage',
    description: 'A direct parent-to-child structural link. Follow these solid edges to understand how a branch evolved step by step.',
    color: '#000000',
    darkColor: '#94a3b8',
    width: 2,
    dashed: false,
    opacity: 1,
  },
  {
    id: 'context-break',
    label: 'Context Break',
    description: 'The branch relationship still exists, but some context in between is inactive, hidden, or intentionally skipped, so the edge is rendered as dashed.',
    color: '#000000',
    darkColor: '#64748b',
    width: 2,
    dashed: true,
    opacity: 0.8,
  },
  {
    id: 'reference',
    label: 'Reference Link',
    description: 'A secondary relationship used for association, reference, or cross-linking. It connects related work without implying direct branch ancestry.',
    color: '#000000',
    darkColor: '#64748b',
    width: 2,
    dashed: true,
    opacity: 0.9,
  },
] as const;

export type GraphEdgeLegendId = typeof EDGE_LEGEND[number]['id'];

export function GraphCanvasIndexPanel({
  isVisible,
  onToggleVisible,
  onPreviewEdgeType,
  onFocusMessage,
  nodes,
  messages,
  agentLabelsById,
  scopeNameById,
  scopeColorById,
}: GraphCanvasIndexPanelProps) {
  const readLookupValue = <T,>(
    lookup: Map<string, T> | Record<string, T> | null | undefined,
    key: string
  ): T | undefined => {
    if (!lookup) return undefined;
    if (lookup instanceof Map) return lookup.get(key);
    return lookup[key];
  };

  const agentLegend = useMemo(() => {
    const assistantAgentMessages = messages.filter(
      (message) => message.role === 'assistant' && typeof message.agent_id === 'string' && message.agent_id.trim().length > 0
    );
    const countsByAgentId = new Map<string, number>();

    assistantAgentMessages.forEach((message) => {
      const agentId = message.agent_id!.trim();
      countsByAgentId.set(agentId, (countsByAgentId.get(agentId) ?? 0) + 1);
    });

    return Array.from(countsByAgentId.entries())
      .map(([agentId, count]) => ({
        agentId,
        label: agentLabelsById.get(agentId) ?? agentId,
        count,
      }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }, [agentLabelsById, messages]);

  const scopeLegend = useMemo(() => {
    const messageById = new Map(messages.map((message) => [message.id, message]));
    const depthByMessageId = new Map<string, number>();
    const getMessageDepth = (message: Message): number => {
      if (typeof message.depth === 'number') return message.depth;

      const cached = depthByMessageId.get(message.id);
      if (cached !== undefined) return cached;

      let depth = 0;
      let current: Message | undefined = message;
      const visited = new Set<string>();

      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const parentId = getGraphParentId(current, messageById);
        if (!parentId) break;
        const parent = messageById.get(parentId);
        if (!parent) break;
        depth += 1;
        current = parent;
      }

      depthByMessageId.set(message.id, depth);
      return depth;
    };

    const isBetterScopeFocusTarget = (candidate: Message, current: Message | null): boolean => {
      if (!current) return true;

      const candidateDepth = getMessageDepth(candidate);
      const currentDepth = getMessageDepth(current);
      if (candidateDepth !== currentDepth) return candidateDepth < currentDepth;

      const candidateCreatedAt = new Date(candidate.createdAt).getTime();
      const currentCreatedAt = new Date(current.createdAt).getTime();
      if (candidateCreatedAt !== currentCreatedAt) return candidateCreatedAt < currentCreatedAt;

      return candidate.id.localeCompare(current.id) < 0;
    };

    const legendByScope = new Map<string, { id: string; name: string; color: string; count: number; focusMessageId: string | null }>();

    nodes.forEach((node) => {
      const data = node.data as LlmNodeData | undefined;
      const scopeId = data?.entity?.scopeId || data?.scopeId || null;
      if (!scopeId) return;

      const existing = legendByScope.get(scopeId);
      const scopeName = data?.scopeName || readLookupValue(scopeNameById, scopeId) || scopeId.slice(0, 8);
      const scopeColor = data?.scopeColor || readLookupValue(scopeColorById, scopeId) || '#94a3b8';

      if (existing) {
        existing.count += 1;
        const focusMessageId = data?.entity?.focusMessageId || data?.entity?.messageId || data?.message?.id || null;
        const focusMessage = focusMessageId ? messageById.get(focusMessageId) ?? null : null;
        const currentFocusMessage = existing.focusMessageId ? messageById.get(existing.focusMessageId) ?? null : null;

        if (focusMessage && isBetterScopeFocusTarget(focusMessage, currentFocusMessage)) {
          existing.focusMessageId = focusMessage.id;
        }
        return;
      }

      const focusMessageId = data?.entity?.focusMessageId || data?.entity?.messageId || data?.message?.id || null;
      const focusMessage = focusMessageId ? messageById.get(focusMessageId) ?? null : null;

      legendByScope.set(scopeId, {
        id: scopeId,
        name: scopeName,
        color: scopeColor,
        count: 1,
        focusMessageId: focusMessage?.id ?? null,
      });
    });

    return Array.from(legendByScope.values()).sort((left, right) => right.count - left.count);
  }, [messages, nodes, scopeColorById, scopeNameById]);

  // Modern icon button styles
  const iconButtonBase = "group relative flex items-center justify-center rounded-lg transition-all duration-200 ease-out";
  const iconButtonGhost = "hover:bg-gradient-to-br hover:from-muted/80 hover:to-muted/40 hover:shadow-sm hover:shadow-black/5 active:scale-95";
  const iconContainer = "flex items-center justify-center transition-transform duration-200 group-hover:scale-110 group-active:scale-95";

  return (
    <>
      {isVisible ? (
        <div className="absolute top-3 right-3 bg-background/95 dark:bg-slate-900/95 rounded-lg shadow-sm border border-border/50 dark:border-slate-700/50 p-2 text-[10px] max-w-[180px] max-h-[240px] overflow-y-auto z-20">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-medium text-foreground dark:text-slate-200 text-xs">Index</div>
            <button
              type="button"
              onClick={() => onToggleVisible(false)}
              className={cn(
                iconButtonBase,
                iconButtonGhost,
                "h-6 w-6 text-muted-foreground dark:text-slate-400 hover:text-foreground dark:hover:text-slate-200"
              )}
              aria-label="Hide index"
              title="Hide index"
            >
              <span className={iconContainer}>
                <EyeOff className="h-3 w-3" />
              </span>
            </button>
          </div>

            <div className="mb-2">
              <div className="text-[9px] font-medium text-muted-foreground dark:text-slate-500 uppercase tracking-wide mb-1 px-0.5">
                Edges
              </div>
              <div className="space-y-1">
                {EDGE_LEGEND.map((item) => (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    title={item.description}
                    className="rounded px-0.5 py-0.5 cursor-pointer hover:bg-muted/50 dark:hover:bg-slate-800/50 transition-colors outline-none focus-visible:bg-muted/60 dark:focus-visible:bg-slate-800/60"
                    onClick={() => onPreviewEdgeType(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onPreviewEdgeType(item.id);
                      }
                    }}
                  >
                    <div className="flex items-center gap-1.5">
                      <div
                        className="w-6 border-t rounded-sm flex-shrink-0 dark:hidden"
                        style={{
                          borderTopColor: item.color,
                          borderTopWidth: item.width,
                          borderTopStyle: item.dashed ? 'dashed' : 'solid',
                          opacity: item.opacity,
                        }}
                      />
                      <div
                        className="w-6 border-t rounded-sm flex-shrink-0 hidden dark:block"
                        style={{
                          borderTopColor: item.darkColor,
                          borderTopWidth: item.width,
                          borderTopStyle: item.dashed ? 'dashed' : 'solid',
                          opacity: item.opacity,
                        }}
                      />
                      <span className="text-foreground dark:text-slate-300 text-[10px] font-medium leading-tight">
                        {item.label}
                      </span>
                      </div>
                  </div>
                ))}
              </div>
            </div>

          {agentLegend.length > 0 && (
            <div className="mb-2">
              <div className="text-[9px] font-medium text-muted-foreground dark:text-slate-500 uppercase tracking-wide mb-1 px-0.5">
                Agents
              </div>
              <div className="space-y-0.5">
                {agentLegend.map(({ agentId, label, count }) => (
                  <div key={agentId} className="flex items-center gap-1.5 group cursor-pointer hover:bg-muted/50 dark:hover:bg-slate-800/50 rounded px-0.5 py-px transition-colors">
                    <div className="w-3 h-0.5 rounded-sm flex-shrink-0 bg-sky-500 dark:bg-sky-400" />
                    <span className="text-foreground dark:text-slate-300 truncate flex-1 text-[10px]" title={agentId}>
                      {label}
                    </span>
                    <span className="text-muted-foreground dark:text-slate-400 text-[9px] bg-muted dark:bg-slate-800 px-1 rounded">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {scopeLegend.length > 0 && (
            <div>
              <div className="text-[9px] font-medium text-muted-foreground dark:text-slate-500 uppercase tracking-wide mb-1 px-0.5">
                Scopes
              </div>
              <div className="space-y-0.5">
                {scopeLegend.map(({ id, name, color, count, focusMessageId }) => (
                  <button
                    key={id}
                    type="button"
                    className="flex w-full items-center gap-1.5 group cursor-pointer hover:bg-muted/50 dark:hover:bg-slate-800/50 rounded px-0.5 py-px transition-colors text-left outline-none focus-visible:bg-muted/60 dark:focus-visible:bg-slate-800/60 disabled:cursor-default disabled:hover:bg-transparent"
                    onClick={() => {
                      if (focusMessageId) onFocusMessage(focusMessageId);
                    }}
                    disabled={!focusMessageId}
                    aria-label={`Focus first node in ${name}`}
                    title={id}
                  >
                    <div
                      className="w-0.5 h-3 rounded-sm flex-shrink-0"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-foreground dark:text-slate-300 truncate flex-1 text-[10px]">
                      {name}
                    </span>
                    <span className="text-muted-foreground dark:text-slate-400 text-[9px] bg-muted dark:bg-slate-800 px-1 rounded">{count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="absolute top-3 right-3 z-20">
          <button
            type="button"
            onClick={() => onToggleVisible(true)}
            className={cn(
              iconButtonBase,
              iconButtonGhost,
              "h-8 w-8 rounded-md border border-border/50 dark:border-slate-700/50 bg-background/95 dark:bg-slate-900/95 text-muted-foreground dark:text-slate-400 shadow-sm hover:text-foreground dark:hover:text-slate-200"
            )}
            aria-label="Show index"
            title="Show index"
          >
            <span className={iconContainer}>
              <Eye className="h-3.5 w-3.5" />
            </span>
          </button>
        </div>
      )}
    </>
  );
}
