import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNowStrict } from 'date-fns';
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
import { 
  FolderGit, 
  GitBranch,
  Loader2,
  Plus, 
  Search, 
  ChevronRight, 
  ChevronDown, 
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderOpen,
  X
} from 'lucide-react';
import { useWorkspaceStore, type Workspace } from '../stores/workspaceStore';
import { RepoPrepareActionRequiredError, useWorkspaces, useCreateWorkspace, useRenameWorkspace, useDeleteWorkspace } from '../hooks/useWorkspaces';
import type { RepoDirtyStrategy } from '../hooks/useWorkspaces';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../@/components/ui/dialog';
import { Button } from '../../@/components/ui/button';
import { Input } from '../../@/components/ui/input';
import { ScrollArea } from '../../@/components/ui/scroll-area';
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
import { cn } from '../lib/utils';
import { Badge } from '../../@/components/ui/badge';
import { useToast } from './Toast';
import { agentClient } from '../lib/agentClient';
import { getErrorMessage } from '../lib/api';
import { Alert, AlertDescription, AlertTitle } from '../../@/components/ui/alert';
import { finalizeCreatedWorkspace } from '../lib/finalizeCreatedWorkspace';
import { WorkspaceDeleteDialog } from './WorkspaceDeleteDialog';
import { WorkspaceRenameDialog } from './WorkspaceRenameDialog';
import { ChangedFilesSummary } from './ChangedFilesSummary';

interface WorkspaceSelectionDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

const formatRelativeTime = (timestamp?: string): string => {
  if (!timestamp) return '-';
  try {
    return formatDistanceToNowStrict(new Date(timestamp), { addSuffix: true });
  } catch {
    return '-';
  }
};

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

  const sortedGroups = Array.from(groups.values()).sort((a, b) => 
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );

  if (unassigned.length > 0) {
    sortedGroups.push({
      id: 'unassigned',
      path: '',
      name: 'Unassigned Workspaces',
      workspaces: unassigned,
    });
  }

  return sortedGroups;
}

function getWorkspaceDisplayName(workspace: Workspace): string {
  if (workspace.name && workspace.name !== 'New Workspace') {
    return workspace.name;
  }
  return `Workspace ${workspace.id.substring(0, 6)}`;
}

function normalizeWorkspacePath(path?: string | null): string | null {
  if (!path) return null;
  const normalized = path.trim().replace(/[\\/]+$/, '');
  if (!normalized) return null;
  return normalized.toLowerCase();
}

function getWorkspaceRepoPath(workspace: Workspace): string | null {
  return normalizeWorkspacePath(workspace.repo_path || workspace.git_repo_path || workspace.folderPath);
}

function getWorkspacesForRepo(workspaces: Workspace[], repoPath: string): Workspace[] {
  const normalizedRepoPath = normalizeWorkspacePath(repoPath);
  if (!normalizedRepoPath) return [];

  return workspaces
    .filter((workspace) => getWorkspaceRepoPath(workspace) === normalizedRepoPath)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

interface RepoSectionProps {
  repo: RepoGroup;
  selectedWorkspaceId: string | null;
  searchTerm: string;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: (folderPath: string) => void;
  onRenameWorkspace: (workspace: Workspace) => void;
  onDeleteWorkspace: (workspace: Workspace) => void;
  onClose: () => void;
}

const RepoSection = memo(function RepoSection({ 
  repo, 
  selectedWorkspaceId, 
  searchTerm,
  onSelectWorkspace, 
  onAddWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onClose
}: RepoSectionProps) {
  const [isOpen, setIsOpen] = useState(true);

  // Filter workspaces based on search term
  const filteredWorkspaces = useMemo(() => {
    if (!searchTerm.trim()) return repo.workspaces;
    const term = searchTerm.toLowerCase();
    return repo.workspaces.filter(w => 
      getWorkspaceDisplayName(w).toLowerCase().includes(term)
    );
  }, [repo.workspaces, searchTerm]);

  const hasSelectedWorkspace = repo.workspaces.some(w => w.id === selectedWorkspaceId);
  const shouldExpand = isOpen || hasSelectedWorkspace || searchTerm.trim().length > 0;

  // If all workspaces filtered out, don't show this repo
  if (searchTerm.trim() && filteredWorkspaces.length === 0) {
    return null;
  }

  const isUnassigned = repo.id === 'unassigned';

  const handleAddWorkspace = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (repo.path) {
      onAddWorkspace(repo.path);
    }
  };

  return (
    <div className="mb-3 [content-visibility:auto] [contain-intrinsic-size:96px]">
      <Collapsible open={shouldExpand} onOpenChange={setIsOpen}>
        <div className={cn(
          "flex flex-col rounded-lg transition-colors",
          hasSelectedWorkspace ? "bg-primary/5" : "hover:bg-muted/50"
        )}>
          {/* Repo Header */}
          <div className="flex items-center gap-2 px-3 py-2">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-2 flex-1 min-w-0 text-left">
                <span className="flex-shrink-0 text-muted-foreground transition-transform duration-200">
                  {shouldExpand ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </span>
                <span className="flex-shrink-0 text-primary">
                  <FolderGit className="h-5 w-5" />
                </span>
                <div className="flex-1 min-w-0">
                  <span className="block truncate font-semibold text-foreground">
                    {repo.name}
                  </span>
                  {repo.path && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {repo.path}
                    </span>
                  )}
                </div>
                <Badge variant="secondary" className="flex-shrink-0 text-xs">
                  {repo.workspaces.length}
                </Badge>
              </button>
            </CollapsibleTrigger>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="h-8 w-8 flex-shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
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

          <CollapsibleContent className="overflow-hidden transition-all data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
            <div className="ml-6 pl-4 border-l border-border/50 mt-1 space-y-1 pb-2">
              {filteredWorkspaces.map((workspace) => {
                const isSelected = selectedWorkspaceId === workspace.id;
                return (
                  <div
                    key={workspace.id}
                    className={cn(
                      "group flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-150",
                      isSelected 
                        ? "bg-primary text-primary-foreground shadow-sm" 
                        : "hover:bg-muted border border-transparent hover:border-border/50"
                    )}
                    onClick={() => {
                      onSelectWorkspace(workspace.id);
                      onClose();
                    }}
                  >
                    <span className={cn(
                      "flex-shrink-0",
                      isSelected ? "text-primary-foreground/80" : "text-muted-foreground"
                    )}>
                      <LayoutGrid className="h-4 w-4" />
                    </span>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "font-medium truncate",
                          isSelected ? "text-primary-foreground" : "text-foreground"
                        )}>
                          {getWorkspaceDisplayName(workspace)}
                        </span>
                      </div>
                      <div className={cn(
                        "text-xs truncate",
                        isSelected ? "text-primary-foreground/70" : "text-muted-foreground"
                      )}>
                        Updated {formatRelativeTime(workspace.updatedAt)}
                      </div>
                    </div>

                    {isSelected && (
                      <Badge variant="outline" className={cn(
                        "flex-shrink-0 text-xs border-current",
                        isSelected ? "text-primary-foreground border-primary-foreground/30" : ""
                      )}>
                        Active
                      </Badge>
                    )}

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className={cn(
                            "h-7 w-7 flex-shrink-0",
                            isSelected 
                              ? "opacity-100 hover:bg-primary-foreground/20 text-primary-foreground" 
                              : "opacity-0 group-hover:opacity-100"
                          )}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => {
                          e.stopPropagation();
                          onRenameWorkspace(workspace);
                        }}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem 
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteWorkspace(workspace);
                          }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
});

RepoSection.displayName = 'RepoSection';

export function WorkspaceSelectionDialog({ isOpen, onOpenChange }: WorkspaceSelectionDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { selectWorkspace, selectedWorkspaceId, dispatchFocus } = useWorkspaceStore();
  const { data: workspacesData, isLoading, isError, error, refetch } = useWorkspaces();
  const createWorkspace = useCreateWorkspace();
  const renameWorkspace = useRenameWorkspace();
  const deleteWorkspace = useDeleteWorkspace();
  const { addToast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const [isContentReady, setIsContentReady] = useState(false);
  const [pendingFolderPath, setPendingFolderPath] = useState<string | null>(null);
  const [workspacePendingDelete, setWorkspacePendingDelete] = useState<Workspace | null>(null);
  const [workspacePendingRename, setWorkspacePendingRename] = useState<Workspace | null>(null);
  const [setupRequirement, setSetupRequirement] = useState<RepoPrepareActionRequiredError['requirement'] | null>(null);
  const [checkpointMessage, setCheckpointMessage] = useState('WIP: pre-agentree checkpoint');
  const contentRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const workspaces = useMemo(() => workspacesData ?? [], [workspacesData]);
  const repoGroups = useMemo(() => groupWorkspacesByRepo(workspaces), [workspaces]);
  const openWorkspace = useCallback((workspaceId: string, options?: { replace?: boolean }) => {
    selectWorkspace(workspaceId);
    navigate(`/workspaces/${encodeURIComponent(workspaceId)}`, { replace: options?.replace ?? false });
  }, [navigate, selectWorkspace]);

  // Filter repos based on search
  const filteredRepoGroups = useMemo(() => {
    if (!searchTerm.trim()) return repoGroups;
    const term = searchTerm.toLowerCase();
    return repoGroups.filter(repo => 
      repo.name.toLowerCase().includes(term) ||
      repo.path.toLowerCase().includes(term) ||
      repo.workspaces.some(w => getWorkspaceDisplayName(w).toLowerCase().includes(term))
    );
  }, [repoGroups, searchTerm]);

  useEffect(() => {
    if (!isOpen) {
      setIsContentReady(false);
      setSetupRequirement(null);
      setPendingFolderPath(null);
      return;
    }

    const frameId = window.requestAnimationFrame(() => setIsContentReady(true));
    return () => window.cancelAnimationFrame(frameId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const appRoot = document.getElementById('root');
    if (!appRoot) return;

    const previousInert = appRoot.getAttribute('inert');
    const previousAriaHidden = appRoot.getAttribute('aria-hidden');
    appRoot.setAttribute('inert', '');
    appRoot.setAttribute('aria-hidden', 'true');

    return () => {
      if (previousInert === null) {
        appRoot.removeAttribute('inert');
      } else {
        appRoot.setAttribute('inert', previousInert);
      }

      if (previousAriaHidden === null) {
        appRoot.removeAttribute('aria-hidden');
      } else {
        appRoot.setAttribute('aria-hidden', previousAriaHidden);
      }
    };
  }, [isOpen]);

  const openExistingRepoToast = useCallback((existingRepoWorkspaces: Workspace[]) => {
    const primaryWorkspace = existingRepoWorkspaces[0];
    const workspaceCount = existingRepoWorkspaces.length;

    addToast({
      title: 'Repository already exists',
      description:
        workspaceCount === 1
          ? `"${getWorkspaceDisplayName(primaryWorkspace)}" is already attached for this repository.`
          : `${workspaceCount} workspaces already exist for this repository. Use the repo menu if you want another workspace there.`,
      variant: 'warning',
      action: workspaceCount === 1
        ? {
            label: 'Open Workspace',
            onClick: () => {
              openWorkspace(primaryWorkspace.id);
              onOpenChange(false);
            },
          }
        : undefined,
    });
  }, [addToast, onOpenChange, openWorkspace]);

  const createWorkspaceForFolder = useCallback(async (
    folderPath: string,
    options?: {
      allowGitInit?: boolean;
      dirtyStrategy?: RepoDirtyStrategy;
      commitMessage?: string | null;
    }
  ) => {
    if (createWorkspace.isPending) return;

    try {
      const created = await createWorkspace.mutateAsync({
        folderPath,
        allowGitInit: options?.allowGitInit ?? false,
        dirtyStrategy: options?.dirtyStrategy,
        commitMessage: options?.commitMessage ?? null,
      });
      setSetupRequirement(null);
      setPendingFolderPath(null);
      if (created?.id) {
        onOpenChange(false);
        navigate(`/workspaces/${encodeURIComponent(created.id)}`);
        void finalizeCreatedWorkspace({
          created,
          fallbackFolderPath: folderPath,
          queryClient,
          selectWorkspace,
          dispatchFocus,
          onImportFailed: (error) => {
            console.error('[WorkspaceSelectionDialog] Initial commit import failed:', error);
            addToast({
              title: 'Workspace created',
              description: 'Initial commit import failed. You can refresh or track branches from the graph.',
              variant: 'warning',
            });
          },
        });
      }
    } catch (error) {
      if (error instanceof RepoPrepareActionRequiredError) {
        setPendingFolderPath(folderPath);
        setSetupRequirement(error.requirement);
        setCheckpointMessage(error.requirement.defaultCommitMessage);
        return;
      }

      addToast({
        title: 'Unable to add workspace',
        description: error instanceof Error ? error.message : 'Failed to create the workspace.',
        variant: 'error',
      });
    }
  }, [addToast, createWorkspace, dispatchFocus, navigate, onOpenChange, queryClient, selectWorkspace]);

  const handleCreateRepo = async () => {
    if (createWorkspace.isPending) return;

    const selected = await openFolderDialog({ 
      directory: true, 
      title: 'Select Repository Folder' 
    });
    const folderPath = Array.isArray(selected) ? selected[0] : selected;
    if (!folderPath || typeof folderPath !== 'string') return;

    try {
      const repo = await agentClient.attachWorkspace(folderPath);
      const existingRepoWorkspaces = getWorkspacesForRepo(workspaces, repo.repo_path || folderPath);

      if (existingRepoWorkspaces.length > 0) {
        openExistingRepoToast(existingRepoWorkspaces);
        return;
      }

      await createWorkspaceForFolder(folderPath);
    } catch (error) {
      addToast({
        title: 'Unable to open repository',
        description: error instanceof Error ? error.message : 'Failed to inspect the selected folder.',
        variant: 'error',
      });
    }
  };

  const handleAddWorkspaceToRepo = useCallback(async (folderPath: string) => {
    if (!folderPath) {
      addToast({
        title: 'Unable to add workspace',
        description: 'This repository does not have a valid path.',
        variant: 'error',
      });
      return;
    }

    await createWorkspaceForFolder(folderPath);
  }, [addToast, createWorkspaceForFolder]);

  const continueAfterSetupRequirement = useCallback(async (options: {
    allowGitInit?: boolean;
    dirtyStrategy?: RepoDirtyStrategy;
    commitMessage?: string | null;
  }) => {
    if (!pendingFolderPath) return;
    await createWorkspaceForFolder(pendingFolderPath, options);
  }, [createWorkspaceForFolder, pendingFolderPath]);

  const handleRequestRenameWorkspace = (workspace: Workspace) => {
    setWorkspacePendingRename(workspace);
  };

  const handleConfirmRenameWorkspace = async (workspace: Workspace, name: string) => {
    await renameWorkspace.mutateAsync({ id: workspace.id, name });
    setWorkspacePendingRename(null);
  };

  const handleRequestDeleteWorkspace = (workspace: Workspace) => {
    setWorkspacePendingDelete(workspace);
  };

  const handleConfirmDeleteWorkspace = async () => {
    if (!workspacePendingDelete) return;
    await deleteWorkspace.mutateAsync(workspacePendingDelete.id);
    setWorkspacePendingDelete(null);
  };

  const handleDialogKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;

    const content = contentRef.current;
    if (!content) return;

    const focusableElements = Array.from(
      content.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => element.offsetParent !== null);

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    if (!firstElement || !lastElement) return;

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  }, []);

  return (
    <Dialog modal={false} open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        onKeyDown={handleDialogKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInputRef.current?.focus();
        }}
        className="sm:max-w-[800px] h-[80vh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl flex items-center gap-2">
                <FolderGit className="h-5 w-5 text-primary" />
                Workspaces
              </DialogTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Manage your repositories and workspaces
              </p>
            </div>
            <Button 
              onClick={handleCreateRepo} 
              disabled={createWorkspace.isPending}
              className="gap-2"
            >
              {createWorkspace.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              New Repository
            </Button>
          </div>
        </DialogHeader>

        {setupRequirement && (
          <div className="border-b bg-orange-50/80 px-6 py-4 text-orange-950">
            {setupRequirement.type === 'git_init' ? (
              <Alert className="border-orange-200 bg-white/70 text-orange-950">
                <GitBranch className="h-4 w-4" />
                <AlertTitle>This folder is not a Git repository yet</AlertTitle>
                <AlertDescription>
                  <p>Agentree needs a Git base commit before it can add a workspace here.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void continueAfterSetupRequirement({ allowGitInit: true })}>
                      Initialize Git and continue
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setSetupRequirement(null)}>
                      Cancel
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : (
              <Alert className="border-orange-200 bg-white/70 text-orange-950">
                <GitBranch className="h-4 w-4" />
                <AlertTitle>This repository has local changes</AlertTitle>
                <AlertDescription>
                  <p>Choose a base for the new workspace.</p>
                  <ChangedFilesSummary files={setupRequirement.workspace.changed_files} />
                  <Input
                    value={checkpointMessage}
                    onChange={(event) => setCheckpointMessage(event.target.value)}
                    placeholder="Checkpoint commit message"
                    className="mt-2 border-orange-200 bg-white"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => void continueAfterSetupRequirement({
                        dirtyStrategy: 'checkpoint',
                        commitMessage: checkpointMessage,
                      })}
                    >
                      Create checkpoint commit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void continueAfterSetupRequirement({ dirtyStrategy: 'last-commit' })}
                    >
                      Use last commit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSetupRequirement(null)}>
                      Cancel
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <div className="px-6 py-4 border-b bg-background">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder="Search repositories and workspaces..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 h-10"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <ScrollArea className="flex-1 bg-background">
          <div className="p-6">
            {!isContentReady || isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />
                ))}
              </div>
            ) : isError ? (
              <Alert variant="destructive">
                <AlertTitle>Unable to load workspaces</AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>{getErrorMessage(error)}</p>
                  <Button variant="outline" size="sm" onClick={() => void refetch()}>
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            ) : workspaces.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                  <FolderGit className="h-8 w-8 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  No repositories yet
                </h3>
                <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
                  Get started by adding your first repository. Each repository can have multiple workspaces.
                </p>
                <Button onClick={handleCreateRepo} disabled={createWorkspace.isPending} size="lg" className="gap-2">
                  {createWorkspace.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Add Your First Repository
                </Button>
              </div>
            ) : filteredRepoGroups.length === 0 ? (
              <div className="text-center py-12">
                <Search className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  No results found
                </h3>
                <p className="text-sm text-muted-foreground">
                  Try adjusting your search terms
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {filteredRepoGroups.map((repo) => (
                  <RepoSection
                    key={repo.id}
                    repo={repo}
                    selectedWorkspaceId={selectedWorkspaceId}
                    searchTerm={searchTerm}
                    onSelectWorkspace={openWorkspace}
                    onAddWorkspace={handleAddWorkspaceToRepo}
                    onRenameWorkspace={handleRequestRenameWorkspace}
                    onDeleteWorkspace={handleRequestDeleteWorkspace}
                    onClose={() => onOpenChange(false)}
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer Stats */}
        {workspaces.length > 0 && (
          <div className="px-6 py-3 border-t bg-muted/30 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {repoGroups.filter(g => g.id !== 'unassigned').length} repositories
            </span>
            <span>
              {workspaces.length} workspaces
            </span>
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
        <WorkspaceRenameDialog
          workspace={workspacePendingRename}
          isRenaming={renameWorkspace.isPending}
          onOpenChange={(open) => {
            if (!open && !renameWorkspace.isPending) {
              setWorkspacePendingRename(null);
            }
          }}
          onRename={handleConfirmRenameWorkspace}
        />
      </DialogContent>
    </Dialog>
  );
}
