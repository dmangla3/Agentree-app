import { type AgentStatus } from '@shared/agentStatus';

export function AgentStateOverlay({ status }: { status: AgentStatus | string | null | undefined }) {
    if (!status) return null;
    const normalized = String(status).trim().toLowerCase();
    const isSetupActive = normalized === 'creating' || normalized === 'initializing' || normalized === 'preparing_worktree';

    if (normalized === 'running' || normalized === 'streaming' || normalized === 'finalizing') {
        return (
            <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden mix-blend-overlay rounded-inherit">
                <div className="absolute inset-0 bg-blue-400/10 dark:bg-blue-500/15 animate-pulse" />
                <div className="absolute inset-0 rounded-inherit border border-blue-400/40 dark:border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.3)] animate-pulse" />
            </div>
        );
    }

    if (normalized === 'pending' || isSetupActive) {
        return (
            <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden mix-blend-overlay rounded-inherit">
                <div className="absolute inset-0 bg-amber-400/15 dark:bg-amber-500/20 animate-pulse" />
                <div className="absolute inset-0 rounded-inherit border border-amber-400/50 dark:border-amber-500/60 shadow-[0_0_12px_rgba(251,191,36,0.35)] animate-pulse" />
            </div>
        );
    }

    return null;
}
