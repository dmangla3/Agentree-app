// client/src/components/InsightPanel.tsx
// Displays surfaced insights from background agents at the bottom of the graph

import { useState } from 'react';
import { X, ChevronDown, ChevronUp, ExternalLink, Eye, Trash2, GitBranch, Lightbulb } from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import { cn } from '../lib/utils';
import { Insight } from '../stores/workspaceStore';

// Types matching server-side GhostBranch
// (Imported from workspaceStore)

interface InsightPanelProps {
    insights: Insight[];
    isVisible?: boolean;
    onToggleVisibility?: () => void;
    onViewInsight?: (insight: Insight) => void;
    onDismissInsight?: (insightId: string) => void;
    onPromoteToBranch?: (insight: Insight) => void;
    className?: string;
}

const AGENT_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
    hypothesis: { icon: '💭', label: 'Hypothesis', color: 'text-purple-600 dark:text-purple-400' },
    doubt: { icon: '⚠️', label: 'Verification', color: 'text-amber-600 dark:text-amber-400' },
    meta: { icon: '🔄', label: 'Meta', color: 'text-blue-600 dark:text-blue-400' },
    association: { icon: '🔗', label: 'Connection', color: 'text-emerald-600 dark:text-emerald-400' },
    memory: { icon: '🧠', label: 'Memory', color: 'text-pink-600 dark:text-pink-400' },
    kb: { icon: '📚', label: 'Document', color: 'text-orange-600 dark:text-orange-400' },
};

function InsightCard({
    insight,
    onView,
    onDismiss,
    onPromote,
    isExpanded,
    onToggleExpand
}: {
    insight: Insight;
    onView?: () => void;
    onDismiss?: () => void;
    onPromote?: () => void;
    isExpanded: boolean;
    onToggleExpand: () => void;
}) {
    const config = AGENT_CONFIG[insight.agentType] || AGENT_CONFIG.hypothesis;
    const isGlobal = !insight.isLocal;

    return (
        <div className={cn(
            "bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700",
            "shadow-sm hover:shadow-md transition-shadow duration-200",
            "overflow-hidden"
        )}>
            {/* Header */}
            <div
                className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                onClick={onToggleExpand}
            >
                <span className="text-lg">{config.icon}</span>
                <span className={cn("text-xs font-medium uppercase tracking-wide", config.color)}>
                    {config.label}
                </span>
                {isGlobal && (
                    <span className="text-xs text-gray-400 flex items-center gap-0.5">
                        <ExternalLink className="w-3 h-3" />
                    </span>
                )}
                <div className="flex-1" />
                {insight.validationResults?.confidence && (
                    <span className="text-xs text-gray-500">
                        {Math.round(insight.validationResults.confidence * 100)}%
                    </span>
                )}
                {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-gray-400" />
                ) : (
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                )}
            </div>

            {/* Content - always visible */}
            <div className="px-3 pb-2">
                <p className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed">
                    {insight.content}
                </p>
            </div>

            {/* Expanded content */}
            {isExpanded && (
                <div className="px-3 pb-3 space-y-3 border-t border-gray-100 dark:border-gray-700 pt-3">
                    {insight.fullExploration && (
                        <div className="text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50 rounded p-2">
                            <p className="font-medium mb-1">Analysis:</p>
                            <p className="leading-relaxed">{insight.fullExploration}</p>
                        </div>
                    )}

                    {insight.reasoning && (
                        <p className="text-xs text-gray-500 italic">
                            Why: {insight.reasoning}
                        </p>
                    )}

                    {/* Actions */}
                    <div className="flex gap-2 pt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            className="text-xs h-7"
                            onClick={(e) => {
                                e.stopPropagation();
                                onView?.();
                            }}
                        >
                            <Eye className="w-3 h-3 mr-1" />
                            View
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="text-xs h-7"
                            onClick={(e) => {
                                e.stopPropagation();
                                onPromote?.();
                            }}
                        >
                            <GitBranch className="w-3 h-3 mr-1" />
                            Branch
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs h-7 text-gray-400 hover:text-red-500"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDismiss?.();
                            }}
                        >
                            <Trash2 className="w-3 h-3" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

export function InsightPanel({
    insights,
    isVisible = true,
    onToggleVisibility,
    onViewInsight,
    onDismissInsight,
    onPromoteToBranch,
    className,
}: InsightPanelProps) {
    const [isMinimized, setIsMinimized] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    if (!isVisible || insights.length === 0) {
        return null;
    }

    return (
        <div className={cn(
            "absolute bottom-4 left-4 right-4 z-50",
            "bg-gray-50/95 dark:bg-gray-900/95 backdrop-blur-sm",
            "rounded-xl border border-gray-200 dark:border-gray-700",
            "shadow-xl",
            "max-h-80 overflow-hidden",
            "transition-all duration-300",
            isMinimized && "max-h-12",
            className
        )}>
            {/* Header */}
            <div
                className={cn(
                    "flex items-center gap-2 px-4 py-3 cursor-pointer",
                    "border-b border-gray-200 dark:border-gray-700",
                    "bg-white/50 dark:bg-gray-800/50"
                )}
                onClick={() => setIsMinimized(!isMinimized)}
            >
                <Lightbulb className="w-4 h-4 text-yellow-500" />
                <span className="font-medium text-sm text-gray-700 dark:text-gray-300">
                    Insights
                </span>
                <span className="bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-xs px-2 py-0.5 rounded-full">
                    {insights.length}
                </span>
                <div className="flex-1" />
                {isMinimized ? (
                    <ChevronUp className="w-4 h-4 text-gray-400" />
                ) : (
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                )}
                {onToggleVisibility && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-gray-400 hover:text-gray-600"
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleVisibility();
                        }}
                    >
                        <X className="w-4 h-4" />
                    </Button>
                )}
            </div>

            {/* Content */}
            {!isMinimized && (
                <div className="p-4 overflow-y-auto max-h-60 space-y-3">
                    {insights.map((insight) => (
                        <InsightCard
                            key={insight.id}
                            insight={insight}
                            isExpanded={expandedId === insight.id}
                            onToggleExpand={() => setExpandedId(expandedId === insight.id ? null : insight.id)}
                            onView={() => onViewInsight?.(insight)}
                            onDismiss={() => onDismissInsight?.(insight.id)}
                            onPromote={() => onPromoteToBranch?.(insight)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default InsightPanel;
