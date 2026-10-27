import { ChartBar, Graph, House, Key, SignOut } from '@phosphor-icons/react';
import { cn } from '../lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from "../../@/components/ui/avatar";
import { useAuthStore } from '../stores/authStore';
import { logoutCurrentSession } from '../lib/authSession';
import { logoutDesktopBrowserAuth, shouldUseDesktopBrowserAuth } from '../lib/kindeDesktopAuth';
import { ConfigButton } from './ConfigButton';
import { DiagnosticsButton } from './DiagnosticsButton';
import { RailIcon } from './RailIcon';


interface SidebarProps {
    activeView: 'chat' | 'orchestration' | 'tracking' | 'knowledge' | 'logins';
    onViewChange: (view: 'chat' | 'orchestration' | 'tracking' | 'knowledge' | 'logins') => void;
    selectedWorkspaceId: string | null;
    selectedWorkspaceName: string | null;
    selectedWorkspaceRepoPath: string | null;
    worktreePolicyOpen?: boolean;
    onWorktreePolicyOpenChange?: (open: boolean) => void;
    allowContinueWithDefaultPolicy?: boolean;
}

export function Sidebar({
    activeView,
    onViewChange,
    selectedWorkspaceId,
    selectedWorkspaceName,
    selectedWorkspaceRepoPath,
    worktreePolicyOpen,
    onWorktreePolicyOpenChange,
    allowContinueWithDefaultPolicy,
}: SidebarProps) {
    const { user } = useAuthStore();
    const navItems = [
        { id: 'chat' as const, label: 'Home', icon: House },
        { id: 'orchestration' as const, label: 'Orchestration', icon: Graph },
        { id: 'tracking' as const, label: 'Tracking', icon: ChartBar },
        { id: 'logins' as const, label: 'Logins', icon: Key },
    ];

    return (
        <aside className="app-side-rail flex w-16 flex-shrink-0 flex-col items-center py-3">
            <nav className="flex flex-1 flex-col items-center gap-1.5 px-2" aria-label="Primary app views">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeView === item.id;

                    return (
                        <button
                            key={item.id}
                            type="button"
                            className="app-rail-button app-focus-ring"
                            data-active={isActive ? 'true' : 'false'}
                            onClick={() => onViewChange(item.id)}
                            title={item.label}
                            aria-label={item.label}
                            aria-current={isActive ? 'page' : undefined}
                        >
                            <RailIcon icon={Icon} />
                        </button>
                    );
                })}
            </nav>

            <div className="mt-auto flex w-full flex-col items-center gap-3 px-2 pb-2">
                <Avatar className="h-8 w-8 cursor-pointer rounded-lg ring-1 ring-border/70 transition-[box-shadow] hover:ring-[hsl(var(--app-focus)/0.45)]" title={user?.name || 'User'}>
                    <AvatarImage src={user?.pictureUrl || undefined} />
                    <AvatarFallback className="rounded-lg bg-[hsl(var(--app-accent-soft))] text-xs font-semibold text-[hsl(var(--app-accent))]">
                        {user?.name?.[0]?.toUpperCase() || 'U'}
                    </AvatarFallback>
                </Avatar>

                <DiagnosticsButton
                    selectedWorkspaceId={selectedWorkspaceId}
                    selectedWorkspaceName={selectedWorkspaceName}
                />

                <ConfigButton
                    repoPath={selectedWorkspaceRepoPath}
                    open={worktreePolicyOpen}
                    onOpenChange={onWorktreePolicyOpenChange}
                    allowContinueWithDefaultPolicy={allowContinueWithDefaultPolicy}
                />

                <button
                    type="button"
                    className={cn("app-rail-button app-focus-ring hover:text-destructive")}
                    onClick={() => {
                        if (shouldUseDesktopBrowserAuth()) {
                            void logoutDesktopBrowserAuth();
                            return;
                        }
                        void logoutCurrentSession();
                    }}
                    title="Logout"
                    aria-label="Logout"
                >
                    <RailIcon icon={SignOut} />
                </button>
            </div>
        </aside>
    );
}
