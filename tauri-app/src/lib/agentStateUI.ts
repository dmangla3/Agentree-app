import {
    Loader2,
    CheckCircle2,
    AlertCircle,
    XCircle,
    Clock,
    type LucideIcon,
} from 'lucide-react';
import type { AgentStatus } from '@shared/agentStatus';

export interface AgentVisualState {
    icon: LucideIcon;
    label: string;
    animate: boolean;
    // Primary text color (e.g., for icons)
    colorClass: string;
    // Classes for pill badges in chat views
    badgeContainerClass: string;
    // Extra styles for specific places
    bgColorClass: string;
    borderColorClass: string;
}

export function getAgentVisualState(status: AgentStatus | string | null | undefined): AgentVisualState {
    const normalized = typeof status === 'string' ? status.trim().toLowerCase() : 'pending';

    switch (normalized) {
        case 'creating':
            return {
                icon: Loader2,
                label: 'Creating',
                colorClass: 'text-amber-500',
                badgeContainerClass: 'bg-amber-50/80 border-amber-200/70 text-amber-700 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300',
                bgColorClass: 'bg-amber-500/10',
                borderColorClass: 'border-amber-500/20',
                animate: true,
            };
        case 'initializing':
            return {
                icon: Loader2,
                label: 'Initializing',
                colorClass: 'text-amber-500',
                badgeContainerClass: 'bg-amber-50/80 border-amber-200/70 text-amber-700 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300',
                bgColorClass: 'bg-amber-500/10',
                borderColorClass: 'border-amber-500/20',
                animate: true,
            };
        case 'preparing_worktree':
            return {
                icon: Loader2,
                label: 'Preparing worktree',
                colorClass: 'text-amber-500',
                badgeContainerClass: 'bg-amber-50/80 border-amber-200/70 text-amber-700 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300',
                bgColorClass: 'bg-amber-500/10',
                borderColorClass: 'border-amber-500/20',
                animate: true,
            };
        case 'streaming':
        case 'running':
            return {
                icon: Loader2,
                label: 'Running',
                colorClass: 'text-blue-500',
                badgeContainerClass: 'bg-blue-50/80 border-blue-200/70 text-blue-700 dark:bg-blue-950/30 dark:border-blue-900 dark:text-blue-300',
                bgColorClass: 'bg-blue-500/10',
                borderColorClass: 'border-blue-500/20',
                animate: true,
            };
        case 'finalizing':
            return {
                icon: Loader2,
                label: 'Finalizing',
                colorClass: 'text-blue-500',
                badgeContainerClass: 'bg-blue-50/80 border-blue-200/70 text-blue-700 dark:bg-blue-950/30 dark:border-blue-900 dark:text-blue-300',
                bgColorClass: 'bg-blue-500/10',
                borderColorClass: 'border-blue-500/20',
                animate: true,
            };
        case 'completed':
            return {
                icon: CheckCircle2,
                label: 'Completed',
                colorClass: 'text-emerald-500',
                badgeContainerClass: 'bg-emerald-50/80 border-emerald-200/70 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-900 dark:text-emerald-300',
                bgColorClass: 'bg-emerald-500/10',
                borderColorClass: 'border-emerald-500/20',
                animate: false,
            };
        case 'error':
        case 'failed':
        case 'failed_setup':
        case 'failed_spawn':
        case 'failed_finalization':
        case 'failed_runtime':
            return {
                icon: AlertCircle,
                label: normalized === 'error'
                    ? 'Error'
                    : normalized === 'failed_setup'
                        ? 'Setup failed'
                        : normalized === 'failed_spawn'
                            ? 'Spawn failed'
                            : normalized === 'failed_finalization'
                                ? 'Finalization failed'
                                : normalized === 'failed_runtime'
                                    ? 'Runtime failed'
                                    : 'Failed',
                colorClass: 'text-red-500',
                badgeContainerClass: 'bg-red-50/80 border-red-200/70 text-red-700 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300',
                bgColorClass: 'bg-red-500/10',
                borderColorClass: 'border-red-500/20',
                animate: false,
            };
        case 'cancelled':
            return {
                icon: XCircle,
                label: 'Cancelled',
                colorClass: 'text-slate-500',
                badgeContainerClass: 'bg-slate-100 border-slate-200/70 text-slate-600 dark:bg-slate-800/50 dark:border-slate-700 dark:text-slate-400',
                bgColorClass: 'bg-slate-500/10',
                borderColorClass: 'border-slate-500/20',
                animate: false,
            };
        case 'pending':
        default:
            return {
                icon: Clock,
                label: normalized === 'pending' ? 'Pending' : (status || 'Pending'),
                colorClass: 'text-amber-500',
                badgeContainerClass: 'bg-amber-50/80 border-amber-200/70 text-amber-700 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300',
                bgColorClass: 'bg-amber-500/10',
                borderColorClass: 'border-amber-500/20',
                animate: false,
            };
    }
}
