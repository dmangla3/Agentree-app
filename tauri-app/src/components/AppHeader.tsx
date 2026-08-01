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
        <header className="app-toolbar z-30 flex h-12 flex-shrink-0 items-center justify-between px-3.5">
            <div className="flex min-w-0 items-center gap-3">
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
                    className="app-command-button app-focus-ring flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5"
                >
                    <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-[hsl(var(--app-accent-soft))] text-[hsl(var(--app-accent))]">
                        <Folder className="h-3 w-3" />
                    </div>
                    <span className="flex min-w-0 flex-col items-start leading-none">
                        <span className="text-[10px] font-medium text-muted-foreground">
                            workspace
                        </span>
                        <span className="max-w-[13rem] truncate text-xs font-semibold text-foreground">
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
                    className="app-command-button app-focus-ring flex h-8 items-center gap-2 rounded-lg px-2.5"
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
