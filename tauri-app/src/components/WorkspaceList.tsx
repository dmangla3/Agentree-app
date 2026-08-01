import { useMemo, useState, useCallback } from 'react';
import { useWorkspaceStore, type Workspace } from '../stores/workspaceStore';
import { Button } from '../../@/components/ui/button';
import { cn } from '../lib/utils';
import { useWorkspaces, useCreateWorkspace, useRenameWorkspace, useDeleteWorkspace } from '../hooks/useWorkspaces';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import { 
  ChevronRight, 
  ChevronDown, 
  FolderGit, 
  FolderOpen, 
  MoreHorizontal, 
  Plus, 
  Trash2, 
  Pencil, 
  Loader2,
  HardDrive,
  LayoutGrid
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../@/components/ui/dropdown-menu';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../@/components/ui/tooltip';
import { WorkspaceDeleteDialog } from './WorkspaceDeleteDialog';

// Group workspaces by their repo path
interface RepoGroup {
  id: string;
  path: string;
  name: string;
  workspaces: Workspace[];
}

function groupWorkspacesByRepo(workspaces: Workspace[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  const unassigned: Workspace[] = [];

  workspaces.forEach((workspace) => {
    const repoPath = workspace.repo_path || workspace.git_repo_path || workspace.folderPath;
    
    if (!repoPath) {
      unassigned.push(workspace);
      return;
    }

    // Extract repo name from path
    const repoName = repoPath.split(/[/\\]/).pop() || 'Unknown Repo';
    
    if (!groups.has(repoPath)) {
      groups.set(repoPath, {
        id: `repo-${repoPath}`,
        path: repoPath,
        name: repoName,
        workspaces: [],
      });
    }
    
    groups.get(repoPath)!.workspaces.push(workspace);
  });

  // Sort groups by name
  const sortedGroups = Array.from(groups.values()).sort((a, b) => 
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );

  // Add unassigned group if there are unassigned workspaces
  if (unassigned.length > 0) {
    sortedGroups.push({
      id: 'unassigned',
      path: '',
      name: 'Unassigned',
      workspaces: unassigned,
    });
  }

  return sortedGroups;
}

// Get a shorter display name for workspace
function getWorkspaceDisplayName(workspace: Workspace): string {
  if (workspace.name && workspace.name !== 'New Workspace') {
    return workspace.name;
  }
  return `Workspace ${workspace.id.substring(0, 6)}`;
}

interface RepoItemProps {
  repo: RepoGroup;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspaceToRepo: (folderPath: string) => void;
  onRequestDeleteWorkspace: (workspace: Workspace) => void;
  defaultExpanded?: boolean;
}

function RepoItem({ 
  repo, 
  selectedWorkspaceId, 
  onSelectWorkspace, 
  onAddWorkspaceToRepo,
  onRequestDeleteWorkspace,
  defaultExpanded = false 
}: RepoItemProps) {
  const [isOpen, setIsOpen] = useState(defaultExpanded);
  const hasSelectedWorkspace = repo.workspaces.some(w => w.id === selectedWorkspaceId);
  
  // Auto-expand if contains selected workspace
  const shouldExpand = isOpen || hasSelectedWorkspace;

  const handleAddWorkspace = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (repo.path) {
      onAddWorkspaceToRepo(repo.path);
    } else {
      console.warn('Cannot add workspace: repo path is empty');
    }
  };

  const isUnassigned = repo.id === 'unassigned';

  return (
    <Collapsible open={shouldExpand} onOpenChange={setIsOpen} className="w-full">
      <div className={cn(
        "flex flex-col rounded-md transition-all duration-150",
        hasSelectedWorkspace ? "bg-accent/50" : "hover:bg-accent/30"
      )}>
        {/* Repo Header */}
        <div className="flex items-center gap-1 px-2 py-1.5">
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-2 flex-1 min-w-0 text-left">
              <span className="flex-shrink-0 text-muted-foreground transition-transform duration-200">
                {shouldExpand ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </span>
              <span className="flex-shrink-0 text-primary/80">
                <FolderGit className="h-4 w-4" />
              </span>
              <span className="flex-1 truncate text-sm font-medium text-foreground">
                {repo.name}
              </span>
              <span className="flex-shrink-0 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                {repo.workspaces.length}
              </span>
            </button>
          </CollapsibleTrigger>
          
          {/* Add Workspace Button - Always visible for repos with paths */}
          {!isUnassigned && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-6 w-6 flex-shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={handleAddWorkspace}
                    disabled={!repo.path}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Add workspace to this repo</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          
          {/* Repo Actions Dropdown */}
          <DropdownMenu>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-6 w-6 flex-shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>More options</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <DropdownMenuContent align="end" className="w-48">
              {!isUnassigned && (
                <>
                  <DropdownMenuItem onClick={handleAddWorkspace}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Workspace
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem disabled>
                <FolderOpen className="mr-2 h-4 w-4" />
                Open in Finder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Workspaces List */}
        <CollapsibleContent className="overflow-hidden transition-all data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="ml-4 pl-4 border-l border-border/50 space-y-0.5 mt-1 pb-1">
            {repo.workspaces.map((workspace) => (
              <WorkspaceItem
                key={workspace.id}
                workspace={workspace}
                isSelected={selectedWorkspaceId === workspace.id}
                onSelect={() => onSelectWorkspace(workspace.id)}
                onRequestDelete={onRequestDeleteWorkspace}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

interface WorkspaceItemProps {
  workspace: Workspace;
  isSelected: boolean;
  onSelect: () => void;
  onRequestDelete: (workspace: Workspace) => void;
}

function WorkspaceItem({ workspace, isSelected, onSelect, onRequestDelete }: WorkspaceItemProps) {
  const renameWorkspace = useRenameWorkspace();
  const [isRenaming, setIsRenaming] = useState(false);

  const handleRename = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRenaming(true);
    const nextName = window.prompt('Enter new workspace name:', workspace.name);
    if (nextName && nextName.trim()) {
      await renameWorkspace.mutateAsync({ id: workspace.id, name: nextName.trim() });
    }
    setIsRenaming(false);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRequestDelete(workspace);
  };

  return (
    <div
      className={cn(
        "group flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer transition-all duration-150",
        isSelected 
          ? "bg-primary text-primary-foreground shadow-sm" 
          : "hover:bg-accent text-foreground"
      )}
      onClick={onSelect}
    >
      <span className={cn(
        "flex-shrink-0 transition-colors",
        isSelected ? "text-primary-foreground/80" : "text-muted-foreground"
      )}>
        <LayoutGrid className="h-3.5 w-3.5" />
      </span>
      <span className="flex-1 truncate text-sm">
        {getWorkspaceDisplayName(workspace)}
      </span>
      
      {/* Workspace Actions Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button 
            variant="ghost" 
            size="icon" 
            className={cn(
              "h-6 w-6 flex-shrink-0 transition-opacity duration-150",
              isSelected 
                ? "opacity-100 hover:bg-primary-foreground/20 text-primary-foreground" 
                : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
            )}
            onClick={(e) => e.stopPropagation()}
            disabled={isRenaming}
          >
            {isRenaming ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <MoreHorizontal className="h-3.5 w-3.5" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={handleRename} disabled={isRenaming}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem 
            onClick={handleDelete} 
            disabled={isRenaming}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function WorkspaceList() {
  const { selectedWorkspaceId, selectWorkspace } = useWorkspaceStore();
  const { data: workspacesData, isLoading, error } = useWorkspaces();
  const workspaces = useMemo(() => workspacesData ?? [], [workspacesData]);
  const createWorkspace = useCreateWorkspace();
  const deleteWorkspace = useDeleteWorkspace();
  const [workspacePendingDelete, setWorkspacePendingDelete] = useState<Workspace | null>(null);

  const repoGroups = useMemo(() => groupWorkspacesByRepo(workspaces), [workspaces]);

  const handleNewRepo = async () => {
    const selected = await openFolderDialog({ 
      directory: true, 
      title: 'Select Repository Folder' 
    });
    const folderPath = Array.isArray(selected) ? selected[0] : selected;
    if (!folderPath || typeof folderPath !== 'string') return;
    
    createWorkspace.mutate({ folderPath });
  };

  const handleAddWorkspaceToRepo = useCallback(async (folderPath: string) => {
    if (!folderPath) {
      console.error('No folder path provided for new workspace');
      return;
    }
    createWorkspace.mutate({ folderPath });
  }, [createWorkspace]);

  const handleConfirmDeleteWorkspace = useCallback(async () => {
    if (!workspacePendingDelete) return;
    await deleteWorkspace.mutateAsync(workspacePendingDelete.id);
    setWorkspacePendingDelete(null);
  }, [deleteWorkspace, workspacePendingDelete]);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-background">
        <div className="p-3 border-b border-border">
          <div className="h-9 bg-muted rounded-md animate-pulse" />
        </div>
        <div className="flex-1 p-3 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-6 bg-muted rounded animate-pulse" />
              <div className="ml-4 h-5 bg-muted/50 rounded animate-pulse w-3/4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to load workspaces';
    return (
      <div className="flex flex-col h-full bg-background">
        <div className="flex-1 flex flex-col items-center justify-center p-4 text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
            <HardDrive className="h-6 w-6 text-destructive" />
          </div>
          <p className="text-sm font-medium text-destructive mb-1">Error loading workspaces</p>
          <p className="text-xs text-muted-foreground">{errorMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={500}>
      <div className="flex flex-col h-full bg-background border-r border-border">
        {/* Header with New Repo Button */}
        <div className="p-3 border-b border-border bg-muted/30">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button 
                variant="default" 
                size="sm" 
                className="w-full justify-start gap-2 shadow-sm"
                onClick={handleNewRepo}
                disabled={createWorkspace.isPending}
              >
                {createWorkspace.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FolderGit className="h-4 w-4" />
                )}
                <span className="flex-1">New Repository</span>
                <span className="text-xs opacity-60 bg-background/20 px-1.5 py-0.5 rounded">
                  {repoGroups.filter(g => g.id !== 'unassigned').length}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Add a new repository</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Repo List */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {workspaces.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                <FolderGit className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground mb-1">No repositories yet</p>
              <p className="text-xs text-muted-foreground mb-4">
                Add a repository to get started with Agentree
              </p>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleNewRepo}
                disabled={createWorkspace.isPending}
              >
                {createWorkspace.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4 mr-2" />
                )}
                Add Your First Repo
              </Button>
            </div>
          ) : (
            <>
              {repoGroups.map((repo) => (
                <RepoItem
                  key={repo.id}
                  repo={repo}
                  selectedWorkspaceId={selectedWorkspaceId}
                  onSelectWorkspace={selectWorkspace}
                  onAddWorkspaceToRepo={handleAddWorkspaceToRepo}
                  onRequestDeleteWorkspace={setWorkspacePendingDelete}
                  defaultExpanded={repo.id === 'unassigned' || repo.workspaces.some(w => w.id === selectedWorkspaceId)}
                />
              ))}
            </>
          )}
        </div>

        {/* Footer - Stats */}
        {workspaces.length > 0 && (
          <div className="p-2 border-t border-border bg-muted/20">
            <div className="flex items-center justify-between text-xs text-muted-foreground px-2">
              <span>{repoGroups.filter(g => g.id !== 'unassigned').length} repos</span>
              <span>{workspaces.length} workspaces</span>
            </div>
          </div>
        )}
        <WorkspaceDeleteDialog
          workspace={workspacePendingDelete}
          isDeleting={deleteWorkspace.isPending}
          onOpenChange={(open) => {
            if (!open && !deleteWorkspace.isPending) {
              setWorkspacePendingDelete(null);
            }
          }}
          onConfirm={handleConfirmDeleteWorkspace}
        />
      </div>
    </TooltipProvider>
  );
}
