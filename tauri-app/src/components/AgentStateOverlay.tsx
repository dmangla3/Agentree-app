import { type AgentStatus } from '@shared/agentStatus';

export function AgentStateOverlay({ status }: { status: AgentStatus | string | null | undefined }) {
    if (!status) return null;
    const normalized = String(status).trim().toLowerCase();
    const isSetupActive = normalized === 'creating' || normalized === 'initializing' || normalized === 'preparing_worktree';

    if (normalized === 'running' || normalized === 'streaming' || normalized === 'finalizing') {
        return (
            <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-inherit">
                <div className="absolute inset-0 animate-pulse bg-[hsl(var(--app-accent)/0.08)] motion-reduce:animate-none" />
                <div className="absolute inset-0 animate-pulse rounded-inherit border border-[hsl(var(--app-accent)/0.34)] shadow-[0_0_14px_hsl(var(--app-accent)/0.18)] motion-reduce:animate-none" />
            </div>
        );
    }

    if (normalized === 'pending' || isSetupActive) {
        return (
            <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-inherit">
                <div className="absolute inset-0 animate-pulse bg-[hsl(var(--app-warning)/0.1)] motion-reduce:animate-none" />
                <div className="absolute inset-0 animate-pulse rounded-inherit border border-[hsl(var(--app-warning)/0.38)] shadow-[0_0_12px_hsl(var(--app-warning)/0.2)] motion-reduce:animate-none" />
            </div>
        );
    }

    return null;
}
