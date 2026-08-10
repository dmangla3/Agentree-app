import { Search, Folder, ChevronDown, Command } from 'lucide-react';
import { ThemeToggle } from './ui/ThemeToggle';
import logoSrc from '../assets/logo.png';
import { UpdateToolbarButton } from './updates/UpdateManager';
import { WorkspaceShareDialog } from './WorkspaceShareDialog';

interface AppHeaderProps {
    selectedWorkspaceId: string | null;
    selectedWorkspaceName: string | null;
    onOpenWorkspaceSelector: () => void;
    onOpenSearch: () => void;
}

export function AppHeader({
    selectedWorkspaceId,
    selectedWorkspaceName,
    onOpenWorkspaceSelector,
    onOpenSearch,
}: AppHeaderProps) {
    return (
        <header className="app-toolbar z-30 flex h-14 flex-shrink-0 items-center justify-between px-4">
            <div className="flex min-w-0 items-center gap-3.5">
                <div className="flex items-center gap-2.5">
                    <img
                        src={logoSrc}
                        alt="Agentree"
                        className="h-6 w-auto"
                    />
                </div>
                <div className="h-5 w-px bg-border/70" />
                <button
                    type="button"
                    title="Choose workspace"
                    onClick={onOpenWorkspaceSelector}
                    className="app-command-button app-focus-ring flex min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-1.5"
                >
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))] shadow-[inset_0_0_0_1px_hsl(var(--app-accent)/0.1)]">
                        <Folder className="h-3.5 w-3.5" />
                    </div>
                    <span className="flex min-w-0 flex-col items-start leading-none">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            Workspace
                        </span>
                        <span className="mt-1 max-w-[15rem] truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
                            {selectedWorkspaceName || 'Select workspace'}
                        </span>
                    </span>
                    <ChevronDown className="ml-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                </button>
            </div>

            <div className="flex flex-shrink-0 items-center gap-2">
                <UpdateToolbarButton />
                <WorkspaceShareDialog
                    workspaceId={selectedWorkspaceId}
                    workspaceName={selectedWorkspaceName}
                />
                <button
                    type="button"
                    title="Search workspaces, nodes, commits, and messages"
                    onClick={onOpenSearch}
                    className="app-command-button app-focus-ring flex h-9 items-center gap-2 rounded-xl px-3"
                >
                    <Search className="h-3.5 w-3.5" />
                    <span className="hidden text-xs font-medium sm:inline">Search</span>
                    <kbd className="hidden items-center gap-0.5 rounded-md border border-border/70 bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
                        <Command className="h-2.5 w-2.5" />K
                    </kbd>
                </button>
                <div className="h-5 w-px bg-border/70" />
                <ThemeToggle />
            </div>
        </header>
    );
}
