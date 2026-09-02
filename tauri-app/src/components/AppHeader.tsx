import { Search, Command } from 'lucide-react';
import { ThemeToggle } from './ui/ThemeToggle';
import logoSrc from '../assets/logo.png';
import { UpdateToolbarButton } from './updates/UpdateManager';
import { WorkspaceShareDialog } from './WorkspaceShareDialog';

interface AppHeaderProps {
    selectedWorkspaceId: string | null;
    selectedWorkspaceName: string | null;
    onOpenSearch: () => void;
}

export function AppHeader({
    selectedWorkspaceId,
    selectedWorkspaceName,
    onOpenSearch,
}: AppHeaderProps) {
    return (
        <header className="app-toolbar z-30 flex h-12 flex-shrink-0 items-center justify-between px-4">
            <div className="flex min-w-0 items-center gap-3">
                <div className="flex items-center gap-2">
                    <img
                        src={logoSrc}
                        alt="Agentree"
                        className="h-5 w-auto"
                    />
                </div>
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
