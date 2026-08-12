import { MessageSquare, GitMerge, Loader2, CheckCircle2 } from 'lucide-react';
import { cn } from '../lib/utils';
import type { MergeTabRunIndicator } from '../stores/integrationStore';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '../../@/components/ui/tooltip';

interface ChatPanelHeaderProps {
    rightPanelTab: 'chat' | 'merge';
    onTabChange: (tab: 'chat' | 'merge') => void;
    mergeSourceCount: number;
    mergeTabRunIndicator: MergeTabRunIndicator;
    mergeTabAttentionActive: boolean;
}

export function ChatPanelHeader({
    rightPanelTab,
    onTabChange,
    mergeSourceCount,
    mergeTabRunIndicator,
    mergeTabAttentionActive,
}: ChatPanelHeaderProps) {
    const isMergeReviewRunning = mergeTabRunIndicator === 'running';
    const isMergeReviewCompleted = mergeTabRunIndicator === 'completed';

    return (
        <div className="flex items-center justify-between border-b border-border/60 bg-background px-3 py-1.5 flex-shrink-0">
            {/* Chat/Merge Toggle - Pill Style */}
            <div className="flex items-center p-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="inline-flex">
                            <button
                                onClick={() => onTabChange('chat')}
                                className={cn(
                                    "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all",
                                    rightPanelTab === 'chat'
                                        ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm ring-1 ring-slate-200 dark:ring-slate-600"
                                        : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                )}
                            >
                                <MessageSquare className="h-3.5 w-3.5" />
                                Chat
                            </button>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                        Shows the selected project&apos;s conversation and agent runs.
                    </TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="inline-flex">
                            <button
                                onClick={() => onTabChange('merge')}
                                className={cn(
                                    "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all",
                                    rightPanelTab === 'merge'
                                        ? "bg-white dark:bg-slate-700 text-emerald-600 dark:text-emerald-400 shadow-sm ring-1 ring-slate-200 dark:ring-slate-600"
                                        : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200",
                                    mergeTabAttentionActive && "animate-pulse"
                                )}
                            >
                                <GitMerge className="h-3.5 w-3.5" />
                                Merge
                                {isMergeReviewRunning ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" aria-label="Merge AI resolve running" />
                                ) : null}
                                {isMergeReviewCompleted ? (
                                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-label="Merge AI resolve completed" />
                                ) : null}
                            </button>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                        {isMergeReviewRunning
                            ? 'AI resolve is running. You can stay in chat and return when it completes.'
                            : isMergeReviewCompleted
                                ? 'AI resolve completed. Review and approve/apply from the merge tab.'
                                : 'Review selected commit sources before opening the merge workflow.'}
                    </TooltipContent>
                </Tooltip>
                {mergeSourceCount > 0 && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="inline-flex min-w-4 cursor-help items-center justify-center rounded-full bg-emerald-500 px-1.5 py-0 text-[9px] font-bold text-white [font-variant-numeric:tabular-nums]">
                                {mergeSourceCount}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                            {mergeSourceCount} commit {mergeSourceCount === 1 ? 'source' : 'sources'} selected for merge.
                        </TooltipContent>
                    </Tooltip>
                )}
            </div>
        </div>
    );
}
