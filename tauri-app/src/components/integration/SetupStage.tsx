import { useState, useMemo, useEffect, useRef } from 'react';
import { Target, GitBranch, X, ArrowRight, Loader2, Check, Bot, ChevronDown, Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useIntegrationStore } from '../../stores/integrationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useAgents, findDefaultCodexAgentId } from '../../hooks/useAgents';
import { useCommits, CommitWithRef } from '../../hooks/useCommits';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { agentClient, GitMergePreview } from '../../lib/agentClient';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { scheduleMessagesRefreshWhenGraphIdle } from '../../lib/graphInteractionGate';
import { persistMergeCommitGraph } from '../../lib/mergeCommitGraph';
import { Button } from '../../../@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../@/components/ui/card';
import { Label } from '../../../@/components/ui/label';
import { Badge } from '../../../@/components/ui/badge';
import { ScrollArea } from '../../../@/components/ui/scroll-area';
import { Checkbox } from '../../../@/components/ui/checkbox';
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
  onToggle?: (checked: boolean) => void;
  showCheckbox?: boolean;
  isChecked?: boolean;
}

function CommitListItem({ 
  commit, 
  isSelected, 
  isSelectable = true,
  onSelect,
  onToggle,
  showCheckbox = false,
  isChecked = false,
}: CommitListItemProps) {
  return (
    <button
      onClick={() => onSelect?.()}
      disabled={!isSelectable && !showCheckbox}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-left text-[11px] transition-colors',
        isSelected 
          ? 'bg-primary/10 border border-primary/30' 
          : isSelectable || showCheckbox
            ? 'hover:bg-muted'
            : 'opacity-50 cursor-not-allowed'
      )}
    >
      {showCheckbox && (
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <Checkbox 
            checked={isChecked}
            onCheckedChange={onToggle}
            indicatorMode="check"
            className="h-2.5 w-2.5"
          />
        </div>
      )}
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <span className="text-[9px] font-mono text-muted-foreground shrink-0">
          {commit.sha.slice(0, 7)}
        </span>
        {commit.refName && (
          <Badge variant="secondary" className="text-[8px] h-3 px-1 shrink-0 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
            <GitBranch className="h-2 w-2 mr-0.5" />
            {commit.refName}
          </Badge>
        )}
        <span className="truncate font-medium">
          {commit.subject}
        </span>
      </div>
      <span className="text-[8px] text-muted-foreground shrink-0">
        {commit.authored_at ? new Date(commit.authored_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
      </span>
      {isSelected && !showCheckbox && (
        <Check className="h-3 w-3 text-primary shrink-0" />
      )}
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
      <div className="flex items-center justify-center rounded-md border px-3 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading commits...
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-2">
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
    <ScrollArea className="h-64 rounded-md border">
      <div className="p-2 space-y-0.5">
        {availableCommits.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
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
      <div className="flex items-center justify-center rounded-md border px-3 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading commits...
      </div>
    );
  }

  return (
    <div className="space-y-2 mt-2">
      <Label className="text-xs font-medium text-muted-foreground">Available Commits</Label>
      <ScrollArea className="h-64 rounded-md border">
        <div className="p-2 space-y-0.5">
          {availableCommits.length === 0 ? (
            <p className="text-xs text-muted-foreground p-2">
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
                  onToggle={(checked) => handleToggle(commit.sha, checked as boolean)}
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
  isApplying: boolean;
  preview: GitMergePreview | null;
  error: string | null;
  onMergeClean: () => void;
}

function GitConflictPreview({ canCheck, isLoading, isApplying, preview, error, onMergeClean }: GitConflictPreviewProps) {
  if (!canCheck) return null;

  const totalFiles = (preview?.auto_mergeable_files.length || 0) + (preview?.conflicted_files.length || 0);
  const canMergeClean = Boolean(preview && !preview.has_conflicts && totalFiles > 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="h-4 w-4 text-primary" />
          Git Conflict Check
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 rounded-md border px-3 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking code-level git conflicts for this merge...
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : preview ? (
          <>
            <div className="flex flex-wrap gap-3">
              <Badge variant="secondary" className="gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                {preview.auto_mergeable_files.length} auto-mergeable
              </Badge>
              <Badge variant={preview.has_conflicts ? 'destructive' : 'secondary'} className="gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                {preview.conflicted_files.length} conflicts
              </Badge>
            </div>

            {totalFiles === 0 ? (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-sm text-emerald-700 dark:text-emerald-300">
                Nothing new to merge. The selected target already contains these changes.
              </div>
            ) : preview.has_conflicts ? (
              <div className="space-y-3">
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-700 dark:text-amber-300">
                  Standard git found text conflicts that need resolution before this merge can apply cleanly.
                </div>
                <div className="rounded-md border bg-muted/30">
                  <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
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
              <div className="flex flex-col gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-sm text-emerald-700 dark:text-emerald-300 sm:flex-row sm:items-center sm:justify-between">
                <span>No code-level git conflicts were detected for the current selection.</span>
                <Button
                  size="sm"
                  onClick={onMergeClean}
                  disabled={!canMergeClean || isApplying}
                  className="gap-2 self-start sm:self-auto"
                >
                  {isApplying ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Merging...
                    </>
                  ) : (
                    <>
                      <GitBranch className="h-4 w-4" />
                      Merge Now
                    </>
                  )}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-md border px-3 py-3 text-sm text-muted-foreground">
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
    addSource, 
    moveToStage, 
    setPreview,
    initializeFileDecisions,
    setApplyState,
    setResult,
  } = useIntegrationStore();
  const [isCheckingConflicts, setIsCheckingConflicts] = useState(false);
  const [isAgentPopoverOpen, setIsAgentPopoverOpen] = useState(false);
  const previewRequestIdRef = useRef(0);
  const previewReadyKeyRef = useRef<string | null>(null);
  const { data: agents = [] } = useAgents();
  const { data: workspacesData } = useWorkspaces();
  const { selectedWorkspaceId, selectedAgentId, setSelectedAgentId } = useWorkspaceStore();
  const queryClient = useQueryClient();
  
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

  // Fetch filtered commits for source selection
  const { commits: filteredSourceCommits, isLoading: isLoadingSource } = useCommits({
    repoPath: repoPath || null,
    workspaceId: selectedWorkspaceId,
    exclusions: sourceExclusions,
  });

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

  const isLoadingCommits = isLoadingTarget || isLoadingSource;
  const canProceed = Boolean(session.target && session.sources.length > 0);
  const sourceShas = session.sources.map((s) => s.commitSha);
  const selectionKey = session.target ? `${session.target.commitSha}::${sourceShas.join(',')}` : '';
  const isPreviewCurrent = Boolean(canProceed && session.preview && previewReadyKeyRef.current === selectionKey);
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

  const loadPreview = async (moveToNextStage: boolean) => {
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
      if (moveToNextStage) {
        moveToStage('smart-resolution');
      }
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

    if (previewReadyKeyRef.current === selectionKey) return;

    loadPreview(false).catch(() => undefined);
  }, [canProceed, repoPath, selectionKey, session.target]);

  const handleGeneratePreview = async () => {
    if (!canProceed || !repoPath) return;

    if (isPreviewCurrent) {
      moveToStage('smart-resolution');
      return;
    }

    await loadPreview(true);
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
        setPreviewError('Git reported conflicts during apply. Run AI Preview to resolve them.');
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

      await api.patch(`/messages/${resultNodeId}`, {
        output_commit_sha: result.commit_sha,
        git_branch_name: null,
        ai_label: `Merge: ${session.sources.map((source) => source.label).join(', ')}`,
        execution_data: {
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
        },
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
    <div className="flex flex-col h-full space-y-0 relative">
      <div className="flex-1 overflow-y-auto space-y-6 pb-20 pr-2">
        {/* Header */}
        <div className="space-y-1">
          <h3 className="text-lg font-semibold">Configure Merge</h3>
          <p className="text-sm text-muted-foreground">
            Select the target commit and one or more source commits to merge into it.
          </p>
        </div>

        <div className="flex flex-col gap-6">
          {/* Target Selection */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Target className="h-4 w-4 text-primary" />
                Target (base)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {session.target ? (
                <div className="flex items-center gap-2 rounded-md border bg-primary/5 px-3 py-2">
                  <Target className="h-4 w-4 text-primary" />
                  <div className="flex-1 min-w-0">
                    <span className="truncate text-sm block">{session.target.label}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {session.target.commitSha.slice(0, 7)}
                    </span>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">Selected</Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => {
                      const { session, openMergeSession } = useIntegrationStore.getState();
                      if (session) {
                        openMergeSession(session.workspaceId, session.repoPath);
                      }
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

          {/* Source Selection */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <GitBranch className="h-4 w-4 text-primary" />
                Sources ({session.sources.length})
                {session.sources.length > 1 && (
                  <Badge variant="secondary" className="text-[10px]">Multi-source</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {session.target && (
                <MultiSourceSelector
                  commits={sourceCommits}
                  selectedShas={sourceShas}
                  onSelectionChange={handleSourceSelectionChange}
                  excludeSha={session.target.commitSha}
                  isLoading={isLoadingSource}
                />
              )}
            </CardContent>
          </Card>

          <GitConflictPreview
            canCheck={canProceed}
            isLoading={isCheckingConflicts}
            isApplying={isApplyingCleanMerge}
            preview={isPreviewCurrent ? session.preview : null}
            error={previewError}
            onMergeClean={handleMergeClean}
          />
        </div>
      </div>

      {/* Footer Actions */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between border-t bg-background/95 backdrop-blur pt-4 pb-2 pr-4 z-10">
        <div className="text-xs text-muted-foreground">
          {isLoadingCommits ? (
            <span>Loading commits...</span>
          ) : canProceed && !repoPath ? (
            <span>Waiting for repository path...</span>
          ) : isCheckingConflicts ? (
            <span>Checking code-level git conflicts...</span>
          ) : previewError ? (
            <span className="text-destructive">Git conflict check failed. Retry AI preview to try again.</span>
          ) : isPreviewCurrent && session.preview && !session.preview.has_conflicts ? (
            <span className="text-primary">
              Clean git merge is ready. Merge now or run AI preview.
            </span>
          ) : canProceed ? (
            <span className={cn(isPreviewCurrent && 'text-primary')}>
              Ready to start AI preview
            </span>
          ) : (
            <span>
              Select a target and at least one source to continue
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Popover open={isAgentPopoverOpen} onOpenChange={setIsAgentPopoverOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="min-w-[220px] justify-between">
                <div className="flex items-center gap-2 overflow-hidden">
                  <Bot className="h-4 w-4 text-primary shrink-0" />
                  <span className="truncate">{displayName}</span>
                </div>
                <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[500px] h-[400px] p-0" align="end" sideOffset={8}>
              <UnifiedAgentModelSelector
                onSelectAgent={(id) => { setSelectedAgentId(id); setIsAgentPopoverOpen(false); }}
                selectedAgentId={selectedAgentId}
              />
            </PopoverContent>
          </Popover>

          <Button
            onClick={handleGeneratePreview}
            disabled={!canProceed || !repoPath || isCheckingConflicts || isLoadingCommits || isApplyingCleanMerge}
            className="gap-2"
          >
            {isCheckingConflicts ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                AI Preview
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default SetupStage;
