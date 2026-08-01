import { MessageSquare, GitMerge } from 'lucide-react';
import { cn } from '../lib/utils';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '../../@/components/ui/tooltip';

interface ChatPanelHeaderProps {
    rightPanelTab: 'chat' | 'merge';
    onTabChange: (tab: 'chat' | 'merge') => void;
    mergeSourceCount: number;
    mergeTabAttentionActive: boolean;
}

export function ChatPanelHeader({
    rightPanelTab,
    onTabChange,
    mergeSourceCount,
    mergeTabAttentionActive,
}: ChatPanelHeaderProps) {
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
                        View the assistant workspace for the selected project.
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
                            </button>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                        Review selected commits and prepare the merge workflow.
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
                            {mergeSourceCount} commits selected for merge.
                        </TooltipContent>
                    </Tooltip>
                )}
            </div>
        </div>
    );
}
