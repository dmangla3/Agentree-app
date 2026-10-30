import { Search, Command, SquareTerminal } from 'lucide-react';
import { ThemeToggle } from './ui/ThemeToggle';
import logoSrc from '../assets/logo.png';
import { UpdateToolbarButton } from './updates/UpdateManager';
import { WorkspaceShareDialog } from './WorkspaceShareDialog';
import { usesMacOSOverlayTitleBar } from '../hooks/useTauriWorkspace';
import { cn } from '../lib/utils';
import {
    graphHeaderControlClass,
    graphHeaderControlIconClass,
    graphHeaderControlLabelClass,
} from './graphHeaderControlStyles';

interface AppHeaderProps {
    selectedWorkspaceId: string | null;
    selectedWorkspaceName: string | null;
    selectedWorkspaceCloudSyncEnabled: boolean;
    hasTerminalTabs: boolean;
    isTerminalDockVisible: boolean;
    terminalShortcutLabel: string;
    onOpenSearch: () => void;
    onToggleTerminalDock: () => void;
}

export function AppHeader({
    selectedWorkspaceId,
    selectedWorkspaceName,
    selectedWorkspaceCloudSyncEnabled,
    hasTerminalTabs,
    isTerminalDockVisible,
    terminalShortcutLabel,
    onOpenSearch,
    onToggleTerminalDock,
}: AppHeaderProps) {
    const usesOverlayTitleBar = usesMacOSOverlayTitleBar();

    return (
        <header
            data-design-scope="navigation"
            data-design-part="app-header"
            data-tauri-drag-region={usesOverlayTitleBar ? true : undefined}
            className={cn(
                'app-toolbar z-30 flex h-12 flex-shrink-0 items-center justify-between border-b border-border/55 pr-3 antialiased dark:border-white/10',
                usesOverlayTitleBar ? 'pl-[84px]' : 'pl-3'
            )}
        >
            <div data-design-part="app-brand" className="flex min-w-0 items-center">
                <div className="flex items-center">
                    <img
                        src={logoSrc}
                        alt="Agentree"
                        data-design-part="app-logo"
                        className="h-[18px] w-auto"
                    />
                </div>
            </div>

            <div data-design-part="header-actions" className="flex flex-shrink-0 items-center gap-1">
                <div data-design-part="header-action-group" className="flex items-center gap-1">
                    <WorkspaceShareDialog
                        workspaceId={selectedWorkspaceId}
                        workspaceName={selectedWorkspaceName}
                        cloudSyncEnabled={selectedWorkspaceCloudSyncEnabled}
                    />
                </div>
                <div className="mx-1 h-4 w-px bg-border/60 dark:bg-white/10" />
                <div data-design-part="header-action-group" className="flex items-center gap-1">
                    {hasTerminalTabs ? (
                        <button
                            type="button"
                            aria-label={isTerminalDockVisible ? 'Hide terminal dock' : 'Show terminal dock'}
                            aria-pressed={isTerminalDockVisible}
                            title={`${isTerminalDockVisible ? 'Hide terminal dock' : 'Show terminal dock'} (${terminalShortcutLabel})`}
                            onClick={onToggleTerminalDock}
                            className={`app-command-button app-focus-ring relative flex h-9 min-w-9 items-center gap-1.5 rounded-lg px-2.5 transition-[background-color,color,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] after:-inset-0.5 after:absolute after:content-[''] active:scale-[0.96] motion-reduce:transition-none dark:hover:bg-white/[0.06] ${isTerminalDockVisible ? 'bg-[hsl(var(--app-accent-soft)/0.72)] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--app-accent)/0.14)] dark:bg-white/[0.08] dark:text-white dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]' : ''}`}
                        >
                            <SquareTerminal className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="hidden text-xs font-medium sm:inline">Terminal</span>
                            <kbd className="hidden items-center gap-0.5 rounded-md border border-border/70 bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex dark:border-white/10 dark:bg-white/[0.04] dark:text-white/55">
                                {terminalShortcutLabel}
                            </kbd>
                        </button>
                    ) : null}
                    <button
                        type="button"
                        title="Search workspaces, nodes, commits, and messages"
                        onClick={onOpenSearch}
                        data-design-part="graph-header-search"
                        className={graphHeaderControlClass}
                    >
                        <Search className={graphHeaderControlIconClass} aria-hidden="true" />
                        <span className={graphHeaderControlLabelClass}>Search</span>
                        <kbd className="hidden items-center gap-0.5 rounded-md border border-border/70 bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex dark:border-white/10 dark:bg-white/[0.04] dark:text-white/55">
                            <Command className="h-2.5 w-2.5" aria-hidden="true" />K
                        </kbd>
                    </button>
                </div>
                <div className="mx-1 h-4 w-px bg-border/60 dark:bg-white/10" />
                <div data-design-part="header-action-group" className="flex items-center gap-1">
                    <UpdateToolbarButton />
                    <ThemeToggle />
                </div>
            </div>
        </header>
    );
}
