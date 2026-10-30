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
        <aside data-design-scope="navigation" data-design-part="primary-rail" className="app-side-rail flex w-14 flex-shrink-0 flex-col items-center py-2 antialiased dark:border-white/10 dark:bg-[hsl(var(--app-panel))]">
            <nav data-design-part="primary-navigation" className="flex flex-1 flex-col items-center gap-0.5 px-2" aria-label="Primary app views">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeView === item.id;

                    return (
                        <button
                            key={item.id}
                            type="button"
                            className="app-rail-button app-focus-ring relative transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none dark:hover:bg-white/[0.06] dark:data-[active=true]:bg-white/[0.09] dark:data-[active=true]:text-white dark:data-[active=true]:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
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

            <div data-design-part="rail-utilities" className="mt-auto flex w-10 flex-col items-center border-t border-border/60 pt-2 dark:border-white/10">
                <div data-design-part="rail-tools" className="flex flex-col items-center gap-0.5">
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
                </div>

                <div data-design-part="rail-divider" className="my-1.5 h-px w-6 bg-border/60 dark:bg-white/10" />

                <Avatar data-design-part="rail-avatar" className="mb-1 h-8 w-8 rounded-lg ring-1 ring-border/60 dark:ring-white/10" title={user?.name || 'User'}>
                    <AvatarImage src={user?.pictureUrl || undefined} />
                    <AvatarFallback className="rounded-lg bg-[hsl(var(--app-accent-soft))] text-[11px] font-semibold text-[hsl(var(--app-accent))] dark:bg-white/[0.08] dark:text-white/80">
                        {user?.name?.[0]?.toUpperCase() || 'U'}
                    </AvatarFallback>
                </Avatar>

                <button
                    type="button"
                    data-design-part="rail-logout"
                    className={cn("app-rail-button app-focus-ring transition-[background-color,color,transform] duration-150 ease-out hover:text-destructive active:scale-[0.96] motion-reduce:transition-none dark:hover:bg-white/[0.06]")}
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
