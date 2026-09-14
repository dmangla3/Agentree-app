import { useState, useMemo, useEffect, useRef, type KeyboardEvent } from 'react';
import { Target, GitBranch, GitMerge, X, ArrowRight, Loader2, Check, Bot, ChevronDown, Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useIntegrationStore } from '../../stores/integrationStore';
import { useWorkspaceStore, type Message } from '../../stores/workspaceStore';
import { useLoginProfilesStore } from '../../stores/loginProfilesStore';
import { getDefaultPromptOverridesSnapshot } from '../../stores/defaultPromptStore';
import { useAgents, findDefaultCodexAgentId } from '../../hooks/useAgents';
import { filterCommitsReachableFrom, useCommits, CommitWithRef } from '../../hooks/useCommits';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { localNodeKeys, upsertMessagesIntoLocalNodeCache, type LocalNodeMessage } from '../../hooks/useLocalNodes';
import { agentClient, GitMergePreview, type TargetBranchCheckoutStatus } from '../../lib/agentClient';
import { api } from '../../lib/api';
import { getOptionalCloudAuthToken } from '../../lib/authSession';
import { cn } from '../../lib/utils';
import { resolveLoginProfileSelection } from '../../lib/loginProfiles';
import { scheduleMessagesRefreshWhenGraphIdle } from '../../lib/graphInteractionGate';
import { buildMergeAgentArgs, buildMergeAgentPrompt, buildMergeAgentUserContent } from '../../lib/mergeAgentNode';
import { persistMergeCommitGraph } from '../../lib/mergeCommitGraph';
import { persistMergeResultNodeLocally } from './mergeResultNode';
import { Button } from '../../../@/components/ui/button';
import { Checkbox } from '../../../@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '../../../@/components/ui/card';
import { Label } from '../../../@/components/ui/label';
import { Badge } from '../../../@/components/ui/badge';
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '../../../@/components/ui/popover';
import { UnifiedAgentModelSelector } from '../UnifiedAgentModelSelector';

// ═══════════════════════════════════════════════════════════════════════════
// COMMIT LIST ITEM COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

interface CommitListItemProps {
  commit: CommitWithRef;
  isSelected?: boolean;
  isSelectable?: boolean;
  onSelect?: () => void;
  showCheckbox?: boolean;
  isChecked?: boolean;
}

function CommitListItem({ 
  commit, 
  isSelected, 
  isSelectable = true,
  onSelect,
  showCheckbox = false,
  isChecked = false,
}: CommitListItemProps) {
  const isDisabled = !isSelectable && !showCheckbox;
  const rowClassName = cn(
    'flex min-h-8 w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-[11px] transition-[background-color,border-color,box-shadow,transform,opacity] duration-150 active:scale-[0.99]',
    isSelected 
      ? 'border-[hsl(var(--app-graph-commit)/0.34)] bg-[hsl(var(--app-graph-commit)/0.1)] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]' 
      : isSelectable || showCheckbox
        ? 'cursor-pointer border-transparent hover:border-[hsl(var(--app-border)/0.64)] hover:bg-[hsl(var(--app-panel-strong)/0.68)]'
        : 'opacity-50 cursor-not-allowed'
  );
  const handleSelect = () => {
    if (isDisabled) return;
    onSelect?.();
  };
  const handleCheckboxRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleSelect();
  };
  const rowContent = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 rounded border border-[hsl(var(--app-border)/0.46)] bg-[hsl(var(--app-bg-muted)/0.45)] px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground tabular-nums">
          {commit.sha.slice(0, 7)}
        </span>
        {commit.refName && (
          <Badge variant="secondary" className="h-3.5 shrink-0 gap-1 border border-[hsl(var(--app-graph-agent)/0.18)] bg-[hsl(var(--app-graph-agent)/0.1)] px-1 text-[8px] text-[hsl(var(--app-graph-agent))]">
            <GitBranch className="h-2.5 w-2.5" />
            {commit.refName}
          </Badge>
        )}
        <span className="truncate font-medium text-foreground">
          {commit.subject}
        </span>
      </div>
      <span className="shrink-0 text-[9px] font-medium text-muted-foreground">
        {commit.authored_at ? new Date(commit.authored_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
      </span>
      {isSelected && !showCheckbox && (
        <Check className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--app-graph-commit))]" />
      )}
    </>
  );

  if (showCheckbox) {
    return (
      <div
        role="checkbox"
        aria-checked={isChecked}
        tabIndex={0}
        onClick={handleSelect}
        onKeyDown={handleCheckboxRowKeyDown}
        className={rowClassName}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border shadow-xs transition-colors',
            isChecked
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-[hsl(var(--app-bg-muted)/0.45)] text-transparent'
          )}
        >
          <Check className="h-3 w-3" />
        </span>
        {rowContent}
      </div>
    );
  }

  return (
    <button
      onClick={handleSelect}
      disabled={isDisabled}
      className={rowClassName}
    >
      {rowContent}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TARGET SELECTOR COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

interface TargetSelectorProps {
  commits: CommitWithRef[];
  selectedSha: string | null;
  onSelect: (commit: CommitWithRef) => void;
  excludeShas: string[];
  isLoading?: boolean;
}

function TargetSelector({ 
  commits, 
  selectedSha, 
  onSelect,
  excludeShas,
  isLoading = false,
}: TargetSelectorProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.54)] px-3 py-4 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading commits...
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[hsl(var(--app-border)/0.58)] px-3 py-4 text-center text-xs text-muted-foreground">
        No commits available.
      </p>
    );
  }

  // Sort: commits with branch refs first, then by date
  const sortedCommits = useMemo(() => {
    return [...commits].sort((a, b) => {
      // First sort by having a ref name (branch tips first)
      const aHasRef = a.refName ? 1 : 0;
      const bHasRef = b.refName ? 1 : 0;
      if (aHasRef !== bHasRef) return bHasRef - aHasRef;
      
      // Then by date (newest first)
      const aTime = a.authored_at ? new Date(a.authored_at).getTime() : 0;
      const bTime = b.authored_at ? new Date(b.authored_at).getTime() : 0;
      return bTime - aTime;
    });
  }, [commits]);

  // Filter out excluded commits
  const availableCommits = sortedCommits.filter(c => !excludeShas.includes(c.sha));

  return (
    <ScrollArea className="h-52 rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.34)] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)]">
      <div className="space-y-1 p-1.5">
        {availableCommits.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            No commits available.
          </p>
        ) : (
          availableCommits.map((commit) => (
            <CommitListItem
              key={commit.sha}
              commit={commit}
              isSelected={selectedSha === commit.sha}
              isSelectable={true}
              onSelect={() => onSelect(commit)}
            />
          ))
        )}
      </div>
    </ScrollArea>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MULTI-SOURCE SELECTOR COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

interface MultiSourceSelectorProps {
  commits: CommitWithRef[];
  selectedShas: string[];
  onSelectionChange: (shas: string[]) => void;
  excludeSha?: string | null;
  isLoading?: boolean;
}

function MultiSourceSelector({ 
  commits, 
  selectedShas,
  onSelectionChange,
  excludeSha,
  isLoading = false,
}: MultiSourceSelectorProps) {
  // Sort: commits by date (latest first)
  const sortedCommits = useMemo(() => {
    return [...commits].sort((a, b) => {
      const aTime = a.authored_at ? new Date(a.authored_at).getTime() : 0;
      const bTime = b.authored_at ? new Date(b.authored_at).getTime() : 0;
      return bTime - aTime;
    });
  }, [commits]);

  // Filter out excluded commit
  const availableCommits = sortedCommits.filter(c => c.sha !== excludeSha);

  const handleToggle = (sha: string, checked: boolean) => {
    if (checked) {
      onSelectionChange([...selectedShas, sha]);
    } else {
      onSelectionChange(selectedShas.filter(s => s !== sha));
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.54)] px-3 py-4 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading commits...
      </div>
    );
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Available commits</Label>
        {selectedShas.length > 0 ? (
          <span className="rounded-full border border-[hsl(var(--app-border)/0.54)] bg-[hsl(var(--app-panel-strong)/0.58)] px-2 py-0.5 text-[10px] font-semibold text-muted-foreground tabular-nums">
            {selectedShas.length} selected
          </span>
        ) : null}
      </div>
      <ScrollArea className="h-52 rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.34)] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)]">
        <div className="space-y-1 p-1.5">
          {availableCommits.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              No commits available.
            </p>
          ) : (
            availableCommits.map((commit) => {
              const isChecked = selectedShas.includes(commit.sha);
              return (
                <CommitListItem
                  key={commit.sha}
                  commit={commit}
                  showCheckbox={true}
                  isChecked={isChecked}
                  onSelect={() => handleToggle(commit.sha, !isChecked)}
                />
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

interface GitConflictPreviewProps {
  canCheck: boolean;
  isLoading: boolean;
  preview: GitMergePreview | null;
  error: string | null;
}

function GitConflictPreview({ canCheck, isLoading, preview, error }: GitConflictPreviewProps) {
  if (!canCheck) return null;

  const totalFiles = (preview?.auto_mergeable_files.length || 0) + (preview?.conflicted_files.length || 0);

  return (
    <Card className="gap-2 overflow-hidden border-[hsl(var(--app-border)/0.66)] bg-[hsl(var(--app-panel)/0.72)] p-2.5 shadow-[0_14px_34px_-30px_hsl(var(--foreground)/0.4),inset_0_1px_0_hsl(var(--foreground)/0.035)]">
      <CardHeader className="p-0">
        <CardTitle className="flex items-center gap-1.5 text-[13px] leading-none">
          <GitBranch className="h-3.5 w-3.5 text-[hsl(var(--app-graph-commit))]" />
          Git Conflict Check
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-0">
        {isLoading ? (
          <div className="flex items-center gap-2 rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.38)] px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking code-level git conflicts for this merge...
          </div>
        ) : error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : preview ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="gap-1.5 rounded-full border border-[hsl(var(--app-success)/0.24)] bg-[hsl(var(--app-success)/0.1)] text-[hsl(var(--app-success))]">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                {preview.auto_mergeable_files.length} auto-mergeable
              </Badge>
              <Badge variant={preview.has_conflicts ? 'destructive' : 'secondary'} className="gap-1.5 rounded-full">
                <AlertTriangle className="h-3.5 w-3.5" />
                {preview.conflicted_files.length} conflicts
              </Badge>
            </div>

            {totalFiles === 0 ? (
              <div className="rounded-xl border border-[hsl(var(--app-success)/0.28)] bg-[hsl(var(--app-success)/0.1)] px-3 py-2 text-sm text-[hsl(var(--app-success))]">
                Nothing new to merge. The selected target already contains these changes.
              </div>
            ) : preview.has_conflicts ? (
              <div className="space-y-2">
                <div className="rounded-xl border border-[hsl(var(--app-warning)/0.28)] bg-[hsl(var(--app-warning)/0.1)] px-3 py-2 text-sm text-[hsl(var(--app-warning))]">
                  Standard git found text conflicts that need resolution before this merge can apply cleanly.
                </div>
                <div className="overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.32)]">
                  <div className="border-b border-[hsl(var(--app-border)/0.5)] px-3 py-2 text-xs font-medium text-muted-foreground">
                    Conflicted Files
                  </div>
                  <ScrollArea className="max-h-40">
                    <div className="space-y-1 p-3">
                      {preview.conflicted_files.map((file) => (
                        <div key={file} className="font-mono text-xs text-foreground/90">
                          {file}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-[hsl(var(--app-success)/0.34)] bg-[hsl(var(--app-success)/0.1)] px-3 py-2 text-sm text-[hsl(var(--app-success))] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--app-success)/0.14)]">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">Clean git merge ready</p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {totalFiles} file{totalFiles === 1 ? '' : 's'} can be merged directly without starting an AI merge.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.32)] px-3 py-2 text-sm text-muted-foreground">
            Select a target and at least one source to check merge conflicts.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SETUP STAGE
// ═══════════════════════════════════════════════════════════════════════════

export function SetupStage() {
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isApplyingCleanMerge, setIsApplyingCleanMerge] = useState(false);
  const { 
    session, 
    setTarget, 
    clearTarget,
    addSource, 
    moveToStage, 
    closeMergeSession,
    setPreview,
    initializeFileDecisions,
    setApplyState,
    setResult,
  } = useIntegrationStore();
  const [isCheckingConflicts, setIsCheckingConflicts] = useState(false);
  const [isStartingAiMerge, setIsStartingAiMerge] = useState(false);
  const [isAgentPopoverOpen, setIsAgentPopoverOpen] = useState(false);
  const [updateTargetBranch, setUpdateTargetBranch] = useState(false);
  const [targetBranchStatus, setTargetBranchStatus] = useState<TargetBranchCheckoutStatus | null>(null);
  const previewRequestIdRef = useRef(0);
  const previewReadyKeyRef = useRef<string | null>(null);
  const { data: agents = [] } = useAgents();
  const { data: workspacesData } = useWorkspaces();
  const loginProfiles = useLoginProfilesStore((state) => state.profiles);
  const refreshLoginProfiles = useLoginProfilesStore((state) => state.refresh);
  const { selectedWorkspaceId, selectedAgentId, setSelectedAgentId, dispatchFocus } = useWorkspaceStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    void refreshLoginProfiles();
  }, [refreshLoginProfiles]);
  
  const selectedWorkspace = useMemo(() => {
    if (!workspacesData || !session) return null;
    return workspacesData.find((c) => c.id === session.workspaceId);
  }, [workspacesData, session]);

  const repoPath = selectedWorkspace?.git_repo_path || selectedWorkspace?.folderPath || session?.repoPath || null;
  
  // Exclusions for source selection
  const sourceExclusions = useMemo(() => {
    const list: string[] = [];
    if (session?.target?.commitSha) list.push(session.target.commitSha);
    // Excluding already selected sources also excludes commits reachable from them.
    // That keeps ancestor/related commits out of the available pool.
    session?.sources.forEach(s => list.push(s.commitSha));
    return list;
  }, [session?.target?.commitSha, session?.sources]);

  // Fetch all commits for target selection
  const { commits: targetCommits, isLoading: isLoadingTarget } = useCommits({
    repoPath: repoPath || null,
    workspaceId: selectedWorkspaceId,
  });

  const filteredSourceCommits = useMemo(
    () => filterCommitsReachableFrom(targetCommits, sourceExclusions),
    [targetCommits, sourceExclusions]
  );

  if (!session) return null;

  const commitMetadataBySha = useMemo(() => {
    const map = new Map<string, CommitWithRef>();
    for (const commit of targetCommits) map.set(commit.sha, commit);
    for (const commit of filteredSourceCommits) map.set(commit.sha, commit);
    return map;
  }, [targetCommits, filteredSourceCommits]);

  // Combine filtered commits with already selected sources so they don't vanish from the list.
  // Keep the original commit metadata so selected items preserve their sort position.
  const sourceCommits = useMemo(() => {
    const selectedAsCommits: CommitWithRef[] = session.sources.map((source) => {
      const metadata = commitMetadataBySha.get(source.commitSha);
      return {
        sha: source.commitSha,
        parents: metadata?.parents ?? [],
        subject: metadata?.subject ?? source.label,
        author_name: metadata?.author_name ?? null,
        author_email: metadata?.author_email ?? null,
        authored_at: metadata?.authored_at ?? null,
        refName: source.branchName || metadata?.refName,
        refType: metadata?.refType,
      };
    });

    const seen = new Set(selectedAsCommits.map((commit) => commit.sha));
    const uniqueFiltered = filteredSourceCommits.filter((commit) => !seen.has(commit.sha));

    return [...selectedAsCommits, ...uniqueFiltered];
  }, [session.sources, filteredSourceCommits, commitMetadataBySha]);

  const isLoadingCommits = isLoadingTarget;
  const canProceed = Boolean(session.target && session.sources.length > 0);
  const sourceShas = session.sources.map((s) => s.commitSha);
  const selectionKey = session.target ? `${session.target.commitSha}::${sourceShas.join(',')}` : '';
  const isPreviewCurrent = Boolean(canProceed && session.preview);
  const previewTotalFiles = isPreviewCurrent && session.preview
    ? session.preview.auto_mergeable_files.length + session.preview.conflicted_files.length
    : 0;
  const canMergeCleanDirect = Boolean(
    isPreviewCurrent &&
    session.preview &&
    !session.preview.has_conflicts &&
    previewTotalFiles > 0
  );

  // "Also move <target> to the merged commit" gating. Only offered when the
  // target is a real named branch; locked when that branch is checked out with
  // uncommitted changes, because advancing it then needs a clean worktree.
  const targetBranchName = session.target?.branchName ?? null;
  const canOfferTargetUpdate = Boolean(targetBranchName);
  const targetBranchLocked = Boolean(targetBranchStatus?.checked_out && targetBranchStatus?.dirty);
  const targetUpdateDisabled = !canOfferTargetUpdate || targetBranchLocked;
  const shouldUpdateTargetBranch = updateTargetBranch && !targetUpdateDisabled;

  useEffect(() => {
    if (!repoPath || !targetBranchName) {
      setTargetBranchStatus(null);
      return;
    }
    let cancelled = false;
    void agentClient
      .targetBranchCheckoutStatus(repoPath, targetBranchName)
      .then((status) => {
        if (!cancelled) setTargetBranchStatus(status);
      })
      .catch(() => {
        if (!cancelled) setTargetBranchStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, targetBranchName]);

  // Never leave the box ticked while it is disabled (target became dirty, or the
  // target stopped being a branch).
  useEffect(() => {
    if (targetUpdateDisabled && updateTargetBranch) {
      setUpdateTargetBranch(false);
    }
  }, [targetUpdateDisabled, updateTargetBranch]);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) || null;
  const displayName = selectedAgent?.name || 'Select model';

  useEffect(() => {
    if (agents.length === 0) return;
    if (selectedAgentId && agents.some((agent) => agent.id === selectedAgentId)) return;

    const defaultAgentId = findDefaultCodexAgentId(agents);
    if (defaultAgentId) {
      setSelectedAgentId(defaultAgentId);
    }
  }, [agents, selectedAgentId, setSelectedAgentId]);

  const handleTargetSelect = (commit: CommitWithRef) => {
    setPreviewError(null);
    setTarget({
      id: commit.sha,
      type: 'external-commit',
      label: commit.refName || commit.subject.slice(0, 50) || commit.sha.slice(0, 8),
      commitSha: commit.sha,
      branchName: commit.refName,
    });
  };

  const handleSourceSelectionChange = (shas: string[]) => {
    // Determine added
    const newShas = shas.filter(sha => !sourceShas.includes(sha));
    for (const sha of newShas) {
      const commit = sourceCommits.find(c => c.sha === sha);
      if (commit) {
        addSource({
          id: commit.sha,
          type: 'external-commit',
          label: commit.refName || commit.subject.slice(0, 50) || commit.sha.slice(0, 8),
          commitSha: commit.sha,
          branchName: commit.refName,
        });
      }
    }
    
    // Determine removed
    const removedShas = sourceShas.filter(sha => !shas.includes(sha));
    for (const sha of removedShas) {
      const sourceToRemove = session.sources.find(s => s.commitSha === sha);
      if (sourceToRemove) {
        useIntegrationStore.getState().removeSource(sourceToRemove.id);
      }
    }
    setPreviewError(null);
  };

  const loadPreview = async () => {
    if (!canProceed || !repoPath || !session.target) return false;

    const requestId = ++previewRequestIdRef.current;
    setIsCheckingConflicts(true);
    setPreviewError(null);

    try {
      const preview = await agentClient.mergePreview(
        repoPath,
        sourceShas,
        session.target.commitSha
      );

      if (requestId !== previewRequestIdRef.current) return false;

      previewReadyKeyRef.current = selectionKey;
      setPreview(preview);
      initializeFileDecisions();
      return true;
    } catch (err) {
      if (requestId !== previewRequestIdRef.current) return false;

      previewReadyKeyRef.current = null;
      console.error('Failed to generate preview:', err);
      setPreviewError(err instanceof Error ? err.message : 'Failed to generate merge preview');
      return false;
    } finally {
      if (requestId === previewRequestIdRef.current) {
        setIsCheckingConflicts(false);
      }
    }
  };

  useEffect(() => {
    if (!canProceed || !repoPath || !session.target) {
      setPreviewError(null);
      previewReadyKeyRef.current = null;
      setIsCheckingConflicts(false);
      return;
    }

    if (session.preview) {
      previewReadyKeyRef.current = selectionKey;
      return;
    }

    if (previewReadyKeyRef.current === selectionKey) return;

    loadPreview().catch(() => undefined);
  }, [canProceed, repoPath, selectionKey, session.preview, session.target]);

  const handleMergeUsingAi = async () => {
    if (!canProceed || !repoPath || !session.target || !selectedAgent) return;

    setIsStartingAiMerge(true);
    setPreviewError(null);

    try {
      if (!agentClient.hasRuntime()) {
        throw new Error('Local agent runtime is unavailable. Open the installed desktop app to run AI merges.');
      }

      const mergePromptInput = {
        target: {
          label: session.target.label,
          commitSha: session.target.commitSha,
        },
        sources: session.sources.map((source) => ({
          label: source.label,
          commitSha: source.commitSha,
          branchName: source.branchName,
        })),
        defaultPromptOverrides: getDefaultPromptOverridesSnapshot(),
      };
      const prompt = buildMergeAgentPrompt(mergePromptInput);
      const userContent = buildMergeAgentUserContent(mergePromptInput);
      const userNodeId = crypto.randomUUID();
      const nodeId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      const branchName = `agentree/${nodeId}`;
      const graphParentId = session.target.nodeId ?? null;
      const modelId = (selectedAgent as any)?.model_config?.model ?? null;
      const sourceLabels = Object.fromEntries(session.sources.map((source) => [source.commitSha, source.label]));
      const executionData = {
        current_run_id: runId,
        workspace_id: session.workspaceId,
        parentId: userNodeId,
        base_selected_from_node_id: graphParentId,
        started_at: now,
        meta: {
          workflow: 'merge_using_ai',
          merge_target_commit: session.target.commitSha,
          merge_target_branch: session.target.branchName ?? null,
          merge_update_target_branch: shouldUpdateTargetBranch,
          merge_target_node_id: graphParentId,
          merge_source_commits: session.sources.map((source) => source.commitSha),
          merge_source_labels: sourceLabels,
          commit_subject: `AI merge ${session.sources.map((source) => source.label).join(', ')} into ${session.target.label}`,
          git_branch_name: branchName,
          base_commit_sha: session.target.commitSha,
          base_selected_from_node_id: graphParentId,
          context_parent_node_id: userNodeId,
          context_base_node_id: graphParentId,
          provider: selectedAgent.type,
          llmModel: modelId,
          provider_model: modelId,
        },
      };
      const userMessage: Message = {
        id: userNodeId,
        role: 'user',
        content: userContent,
        parentId: null,
        workspaceId: session.workspaceId,
        createdAt: now,
        updatedAt: now,
        status: null,
        base_commit_sha: session.target.commitSha,
        base_selected_from_node_id: graphParentId,
        output_commit_sha: null,
      };
      const message: Message = {
        id: nodeId,
        role: 'assistant',
        content: '',
        parentId: userNodeId,
        workspaceId: session.workspaceId,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        aiLabel: `AI merge: ${session.sources.map((source) => source.label).join(', ')}`,
        agent_id: selectedAgent.id,
        base_commit_sha: session.target.commitSha,
        base_selected_from_node_id: graphParentId,
        output_commit_sha: null,
        git_branch_name: branchName,
        execution_data: executionData,
      };

      const authToken = await getOptionalCloudAuthToken();
      const selectedProvider = selectedAgent.type === 'codex' || selectedAgent.type === 'claude'
        ? selectedAgent.type
        : null;
      const loginProfileSelection = resolveLoginProfileSelection({
        profiles: loginProfiles,
        provider: selectedProvider,
        agentName: selectedAgent.name,
      });
      const selectedLoginProfile = loginProfileSelection.selectedProfile;
      if (!loginProfileSelection.isReady) {
        throw new Error(loginProfileSelection.failureMessage ?? `${selectedAgent.name} needs a ready login profile before it can run.`);
      }
      await Promise.all([
        agentClient.setMcpAuthToken(authToken),
        agentClient.setMcpWorkspaceId(session.workspaceId),
      ]);

      await Promise.all([
        agentClient.upsertLocalNode(session.workspaceId, userNodeId, userMessage),
        agentClient.upsertLocalNode(session.workspaceId, nodeId, message),
      ]);
      const localMessages = [userMessage, message];
      queryClient.setQueryData<LocalNodeMessage[]>(
        localNodeKeys.workspace(session.workspaceId),
        (current) => upsertMessagesIntoLocalNodeCache(current, session.workspaceId, localMessages, {
          syncStatus: 'local_only',
        }),
      );
      queryClient.setQueryData<Message[]>(['messages', session.workspaceId], (current) => {
        const existing = current ?? [];
        const ids = new Set(localMessages.map((item) => item.id));
        return [
          ...existing.filter((item) => !ids.has(item.id)),
          ...localMessages,
        ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
      });
      void queryClient.invalidateQueries({ queryKey: localNodeKeys.workspace(session.workspaceId) });
      dispatchFocus({
        messageId: nodeId,
        source: 'system',
        metadata: {
          reason: 'merge-using-ai-started',
          userNodeId,
          targetCommit: session.target.commitSha,
        },
      });

      await agentClient.startAgentRun({
        runId,
        assistantNodeId: nodeId,
        workspaceId: session.workspaceId,
        repoPath,
        parentCommit: session.target.commitSha,
        agentType: selectedAgent.type,
        args: buildMergeAgentArgs(selectedAgent.cliArgs, selectedAgent.promptFlag, prompt),
        authToken,
        traceId: null,
        loginProfileId: selectedLoginProfile?.id ?? null,
        runContext: {
          runId,
          executionData,
          gitBranchName: branchName,
          repoPath,
          parentCommit: session.target.commitSha,
          authorName: selectedAgent.name,
          promptFallback: prompt,
        },
      });

      void scheduleMessagesRefreshWhenGraphIdle(queryClient, session.workspaceId, {
        reason: 'merge-using-ai-started',
      });
      closeMergeSession();
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Failed to start AI merge');
    } finally {
      setIsStartingAiMerge(false);
    }
  };

  const handleMergeClean = async () => {
    if (!session.target || !repoPath || !isPreviewCurrent || !session.preview || session.preview.has_conflicts) return;

    const totalFiles = session.preview.auto_mergeable_files.length + session.preview.conflicted_files.length;
    if (totalFiles === 0) return;

    const resultNodeId = crypto.randomUUID();
    const currentSourceShas = session.sources.map((source) => source.commitSha);
    const promotedSourceNodeId = session.sources.length === 1
      ? session.sources[0]?.nodeId ?? null
      : null;
    const commitMessage = `Merge ${session.sources.map((source) => source.label).join(', ')} into ${session.target.label}`;

    setIsApplyingCleanMerge(true);
    setPreviewError(null);
    setApplyState({
      status: 'running',
      log: `Applying clean git merge for ${currentSourceShas.length} source${currentSourceShas.length === 1 ? '' : 's'}...`,
    });

    try {
      const result = await agentClient.mergeApply(
        repoPath,
        currentSourceShas,
        session.target.commitSha,
        resultNodeId,
        commitMessage
      );

      if (result.status === 'noop') {
        setApplyState({
          status: 'noop',
          log: result.message || 'Nothing to merge. The target already contains these changes.',
        });
        setPreviewError(result.message || 'Nothing to merge. The target already contains these changes.');
        return;
      }

      if (result.status === 'conflicts') {
        setApplyState({
          status: 'failed',
          log: `Git reported conflicts during apply:\n${result.conflicts.join('\n')}`,
          error: 'Git reported conflicts during apply.',
        });
        setPreviewError('Git reported conflicts during apply. Use Merge Using AI to resolve them.');
        return;
      }

      if (!result.commit_sha) {
        throw new Error('Merge failed: no commit SHA returned');
      }

      await api.post(`/workspaces/${session.workspaceId}/messages`, {
        id: resultNodeId,
        role: 'assistant',
        content: commitMessage,
        parentId: session.target.nodeId || null,
        skipAssistant: true,
      });

      const aiLabel = `Merge: ${session.sources.map((source) => source.label).join(', ')}`;
      const executionData = {
        meta: {
          merge_target_commit: session.target.commitSha,
          merge_source_commits: currentSourceShas,
        },
        merge_metadata: {
          sources: session.sources,
          target: session.target,
          policy: session.policy,
          lineage: {
            mode: promotedSourceNodeId ? 'promote-source' : 'keep-target',
            primary_parent_node_id: promotedSourceNodeId ?? session.target.nodeId ?? null,
            promoted_source_node_id: promotedSourceNodeId,
            source_node_ids: session.sources
              .map((source) => source.nodeId)
              .filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0),
          },
          decisions: 0,
          verified: true,
          review: {
            status: 'skipped-clean-git-check',
            selected_agent_type: null,
            selected_model_id: null,
            summary: null,
            issue_count: 0,
            selected_issue_count: 0,
          },
        },
      };
      const resultParentNodeId = promotedSourceNodeId ?? session.target.nodeId ?? null;

      await api.patch(`/messages/${resultNodeId}`, {
        output_commit_sha: result.commit_sha,
        git_branch_name: null,
        ai_label: aiLabel,
        execution_data: executionData,
      });

      await persistMergeResultNodeLocally({
        queryClient,
        workspaceId: session.workspaceId,
        resultNodeId,
        parentId: resultParentNodeId,
        content: commitMessage,
        commitSha: result.commit_sha,
        aiLabel,
        executionData,
      });

      await persistMergeCommitGraph({
        workspaceId: session.workspaceId,
        repoPath,
        commitSha: result.commit_sha,
        resultNodeId,
        fallbackParents: [session.target.commitSha, ...currentSourceShas],
        fallbackSubject: commitMessage,
      });

      void scheduleMessagesRefreshWhenGraphIdle(queryClient, session.workspaceId, {
        refetchActive: true,
        reason: 'clean-merge-apply',
      });
      setApplyState({
        status: 'passed',
        log: `Clean merge applied. Commit SHA: ${result.commit_sha}`,
      });
      setResult(resultNodeId, result.commit_sha);
      moveToStage('result');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Merge failed';
      setApplyState({
        status: 'failed',
        log: `Error applying merge: ${message}`,
        error: message,
      });
      setPreviewError(message);
    } finally {
      setIsApplyingCleanMerge(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col space-y-0">
      <div className="flex-1 space-y-3 overflow-y-auto pb-20 pr-2">
        {/* Header */}
        <div className="flex flex-col gap-1.5 rounded-xl border border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-panel)/0.58)] p-3 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
          <div className="flex items-center gap-1.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[hsl(var(--app-graph-commit)/0.11)] text-[hsl(var(--app-graph-commit))]">
              <GitMerge className="h-3.5 w-3.5" strokeWidth={1.9} />
            </span>
            <h3 className="text-sm font-semibold text-foreground">Configure Merge</h3>
          </div>
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
            Collect source commits first, then choose the target commit when you are ready to preview or apply.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
          {/* Source Selection */}
          <Card className="gap-2 overflow-hidden border-[hsl(var(--app-border)/0.66)] bg-[hsl(var(--app-panel)/0.72)] p-2.5 shadow-[0_14px_34px_-30px_hsl(var(--foreground)/0.4),inset_0_1px_0_hsl(var(--foreground)/0.035)]">
            <CardHeader className="p-0">
              <CardTitle className="flex items-center gap-1.5 text-[13px] leading-none">
                <GitBranch className="h-3.5 w-3.5 text-[hsl(var(--app-graph-agent))]" />
                Sources ({session.sources.length})
                {session.sources.length > 1 && (
                  <Badge variant="secondary" className="rounded-full border border-[hsl(var(--app-border)/0.54)] bg-[hsl(var(--app-bg-muted)/0.46)] text-[10px]">Multi-source</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-0">
              <MultiSourceSelector
                commits={sourceCommits}
                selectedShas={sourceShas}
                onSelectionChange={handleSourceSelectionChange}
                excludeSha={session.target?.commitSha ?? null}
                isLoading={isLoadingTarget}
              />
              {!session.target ? (
                <div className="rounded-xl border border-dashed border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.28)] px-3 py-2 text-center text-xs text-muted-foreground">
                  Select a target when ready to preview or apply the queued sources.
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Target Selection */}
          <Card className="gap-2 overflow-hidden border-[hsl(var(--app-border)/0.66)] bg-[hsl(var(--app-panel)/0.72)] p-2.5 shadow-[0_14px_34px_-30px_hsl(var(--foreground)/0.4),inset_0_1px_0_hsl(var(--foreground)/0.035)]">
            <CardHeader className="p-0">
              <CardTitle className="flex items-center gap-1.5 text-[13px] leading-none">
                <Target className="h-3.5 w-3.5 text-[hsl(var(--app-graph-commit))]" />
                Target (base)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-0">
              {session.target ? (
                <div className="flex items-center gap-2.5 rounded-xl border border-[hsl(var(--app-graph-commit)/0.28)] bg-[hsl(var(--app-graph-commit)/0.08)] px-3 py-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]">
                  <Target className="h-4 w-4 shrink-0 text-[hsl(var(--app-graph-commit))]" />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{session.target.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      {session.target.commitSha.slice(0, 7)}
                    </span>
                  </div>
                  <Badge variant="secondary" className="rounded-full border border-[hsl(var(--app-graph-commit)/0.2)] bg-[hsl(var(--app-graph-commit)/0.11)] text-[10px] text-[hsl(var(--app-graph-commit))]">Selected</Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-muted-foreground active:scale-[0.96]"
                    onClick={() => {
                      clearTarget();
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <TargetSelector
                  commits={targetCommits}
                  selectedSha={null}
                  onSelect={handleTargetSelect}
                  excludeShas={sourceShas}
                  isLoading={isLoadingTarget}
                />
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          <GitConflictPreview
            canCheck={canProceed}
            isLoading={isCheckingConflicts}
            preview={isPreviewCurrent ? session.preview : null}
            error={previewError}
          />
        </div>
      </div>

      {/* Footer Actions */}
      <div className="absolute bottom-0 left-0 right-0 z-10 flex flex-col gap-2 border-t border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg)/0.88)] py-2 pr-3 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 rounded-full border border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.7)] px-3 py-1.5 text-xs text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
          {isLoadingCommits ? (
            <span>Loading commits...</span>
          ) : canProceed && !repoPath ? (
            <span>Waiting for repository path...</span>
          ) : isCheckingConflicts ? (
            <span>Checking code-level git conflicts...</span>
          ) : isStartingAiMerge ? (
            <span>Starting AI merge agent...</span>
          ) : previewError ? (
            <span className="text-destructive">{previewError}</span>
          ) : isPreviewCurrent && session.preview && !session.preview.has_conflicts && previewTotalFiles > 0 ? (
            <span className="text-[hsl(var(--app-success))]">
              Clean git merge is ready. Merge directly or use AI.
            </span>
          ) : isPreviewCurrent && session.preview && session.preview.has_conflicts ? (
            <span className="text-[hsl(var(--app-warning))]">
              Git conflicts detected. Use AI merge to resolve them.
            </span>
          ) : isPreviewCurrent && previewTotalFiles === 0 ? (
            <span>Nothing new to merge.</span>
          ) : canProceed ? (
            <span className={cn(isPreviewCurrent && 'text-primary')}>
              Ready to start an AI merge agent
            </span>
          ) : (
            <span>
              Select a target and at least one source to continue
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-end">
          <Button
            onClick={handleMergeClean}
            disabled={!canMergeCleanDirect || isApplyingCleanMerge || isStartingAiMerge}
            className={cn(
              "h-8 gap-1.5 rounded-lg px-3 text-xs font-semibold transition-[background-color,border-color,box-shadow,transform,opacity] duration-150 active:scale-[0.96]",
              canMergeCleanDirect
                ? "bg-[hsl(var(--app-success))] text-white shadow-[0_10px_22px_-20px_hsl(var(--app-success)/0.82),inset_0_1px_0_rgba(255,255,255,0.16)] hover:bg-[hsl(var(--app-success)/0.9)]"
                : "border border-[hsl(var(--app-border)/0.54)] bg-[hsl(var(--app-panel)/0.42)] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.025)]"
            )}
          >
            {isApplyingCleanMerge ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" />
                Merge Directly
              </>
            )}
          </Button>

          <div className="flex min-w-[188px] flex-col gap-1">
            <Popover open={isAgentPopoverOpen} onOpenChange={setIsAgentPopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="h-7 w-full justify-between rounded-lg border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel)/0.58)] px-2.5 text-[11px] font-medium shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)] transition-[background-color,border-color,transform,opacity] duration-150 hover:bg-[hsl(var(--app-panel-strong)/0.72)] active:scale-[0.96]"
                >
                  <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <Bot className="h-3 w-3 shrink-0 text-[hsl(var(--app-graph-agent))]" />
                    <span className="shrink-0 text-muted-foreground">AI model</span>
                    <span className="truncate text-foreground">{displayName}</span>
                  </div>
                  <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="h-[400px] w-[min(500px,calc(100vw-2rem))] overflow-hidden rounded-2xl border-[hsl(var(--app-border)/0.7)] p-0 shadow-[0_24px_70px_-38px_hsl(var(--foreground)/0.54)]" align="end" sideOffset={8}>
                <UnifiedAgentModelSelector
                  onSelectAgent={(id) => { setSelectedAgentId(id); setIsAgentPopoverOpen(false); }}
                  selectedAgentId={selectedAgentId}
                />
              </PopoverContent>
            </Popover>

            {canOfferTargetUpdate && (
              <label
                className={cn(
                  'flex items-start gap-2 rounded-md px-1 py-1 text-[11px] leading-snug',
                  targetUpdateDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                )}
                title={
                  targetBranchLocked
                    ? `'${targetBranchName}' has uncommitted changes in its checked-out folder. Commit or stash them to enable moving it.`
                    : `Fast-forwards '${targetBranchName}' to the merge commit. Off by default — the merge commit is created either way.`
                }
              >
                <Checkbox
                  checked={shouldUpdateTargetBranch}
                  onCheckedChange={(value) => setUpdateTargetBranch(value === true)}
                  disabled={targetUpdateDisabled || isStartingAiMerge}
                  className="mt-0.5"
                />
                <span className="text-muted-foreground">
                  Also move <span className="font-medium text-foreground">{targetBranchName}</span> to the merged commit
                  {targetBranchLocked && (
                    <span className="block text-[10px] text-amber-600 dark:text-amber-500">
                      Disabled: commit or stash changes in its checked-out folder first.
                    </span>
                  )}
                </span>
              </label>
            )}

            <Button
              onClick={handleMergeUsingAi}
              disabled={!canProceed || !repoPath || !selectedAgent || isCheckingConflicts || isLoadingCommits || isApplyingCleanMerge || isStartingAiMerge}
              className="h-8 w-full gap-1.5 rounded-lg bg-[hsl(var(--app-graph-commit)/0.92)] px-3 text-xs font-semibold text-white shadow-[0_10px_22px_-20px_hsl(var(--app-graph-commit)/0.88),inset_0_1px_0_rgba(255,255,255,0.16)] transition-[background-color,border-color,box-shadow,transform,opacity] duration-150 hover:bg-[hsl(var(--app-graph-commit))] active:scale-[0.96]"
            >
              {isStartingAiMerge ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Merge Using AI
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SetupStage;
