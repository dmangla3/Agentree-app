import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitCommitHorizontal, Compass, X, Loader2, ChevronDown, GitBranch, Clock3, GitMerge, RefreshCw, Check } from 'lucide-react';
import { agentClient } from '../lib/agentClient';
import {
  canBeAcceptanceGitRef,
  trackedRefCountsAsMerged,
  trackedRefKeys,
  useCreateTrackedRef,
  useDeleteTrackedRef,
  useTrackedRefs,
  useUpdateTrackedRef,
} from '../hooks/useTrackedRefs';
import { branchKeys, useBranches } from '../hooks/useBranches';
import { useCurrentHead } from '../hooks/useCurrentHead';
import { useMessages } from '../hooks/useMessages';
import { shouldShowWorkspaceFeatures } from '../hooks/useTauriWorkspace';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { Button } from '../../@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '../../@/components/ui/popover';
import { Switch } from '../../@/components/ui/switch';
import { cn } from '../lib/utils';
import { useToast } from './Toast';
import { getBranchPointerCommitSha, getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import { sortTrackableRefsByRecentCommit } from '../domain/trackableRefs';

interface TrackedBranchesPanelProps {
  workspaceId: string | null;
  repoPath: string | null;
  showMergedCommits: boolean;
  onShowMergedCommitsChange: (show: boolean) => void;
  isRefreshingGitState: boolean;
  onRefreshGitState: () => void;
  className?: string;
}

const shortCommitSha = (commitSha: string): string => commitSha.slice(0, 8);

const formatCommitAge = (committedAt: string | null | undefined): string => {
  if (!committedAt) return 'unknown';
  const time = new Date(committedAt).getTime();
  if (!Number.isFinite(time)) return 'unknown';
  const diffMs = Date.now() - time;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
};

export function TrackedBranchesPanel({
  workspaceId,
  repoPath,
  showMergedCommits,
  onShowMergedCommitsChange,
  isRefreshingGitState,
  onRefreshGitState,
  className,
}: TrackedBranchesPanelProps) {
  const [selectedRef, setSelectedRef] = useState<string>('');
  const [isTrackBranchPickerOpen, setIsTrackBranchPickerOpen] = useState(false);
  const { data: trackedRefs = [] } = useTrackedRefs(workspaceId);
  const { data: branches = [] } = useBranches(workspaceId);
  const { data: currentHeadSha } = useCurrentHead(repoPath);
  const { data: messages = [] } = useMessages(workspaceId);
  const createTrackedRef = useCreateTrackedRef();
  const deleteTrackedRef = useDeleteTrackedRef();
  const updateTrackedRef = useUpdateTrackedRef();
  const {
    composerBaseCommitOverride,
    composerContextPreview,
    setComposerBaseCommitOverride,
  } = useWorkspaceStore();
  const { addToast, removeToast } = useToast();
  const queryClient = useQueryClient();
  const [isImportingCurrentCheckout, setIsImportingCurrentCheckout] = useState(false);
  const [resolvingCandidateKey, setResolvingCandidateKey] = useState<string | null>(null);
  const isImportingCurrentCheckoutRef = useRef(false);

  const { data: localRefs = [] } = useQuery({
    queryKey: ['local-refs', repoPath ?? ''],
    enabled: Boolean(repoPath && shouldShowWorkspaceFeatures()),
    queryFn: async () => {
      if (!repoPath) return [];
      return agentClient.listLocalRefs(repoPath);
    },
    refetchInterval: 30000,
  });
  const { data: localCommitGraph } = useQuery({
    queryKey: ['local-commit-graph', workspaceId],
    enabled: Boolean(workspaceId && shouldShowWorkspaceFeatures() && agentClient.hasRuntime()),
    queryFn: async () => {
      if (!workspaceId) return { commits: [], commitParents: [], commitObservations: [] };
      return agentClient.listLocalCommitGraph(workspaceId);
    },
    staleTime: 5_000,
  });

  const graphCommitShas = useMemo(() => (
    new Set((localCommitGraph?.commits ?? []).map((commit) => commit.sha).filter(Boolean))
  ), [localCommitGraph?.commits]);
  const selectedComposerCommitSha = composerBaseCommitOverride?.workspaceId === workspaceId
    ? composerBaseCommitOverride.commitSha
    : composerContextPreview?.workspaceId === workspaceId
      ? composerContextPreview.baseCommitSha
      : null;

  const trackableRefs = useMemo(() => {
    const trackedSet = new Set(trackedRefs.map((ref) => ref.git_ref));
    return sortTrackableRefsByRecentCommit(localRefs.filter((ref) => !trackedSet.has(ref.git_ref)));
  }, [localRefs, trackedRefs]);
  const acceptanceBranchCount = useMemo(
    () => trackedRefs.filter((ref) => ref.enabled && trackedRefCountsAsMerged(ref)).length,
    [trackedRefs]
  );
  const pendingAcceptanceCandidates = localCommitGraph?.pendingAcceptanceCandidates ?? [];

  const resolveAcceptanceCandidate = useCallback(async (
    candidate: typeof pendingAcceptanceCandidates[number],
    accepted: boolean
  ) => {
    if (!workspaceId) return;
    const candidateKey = `${candidate.gitRef}:${candidate.sourceSha}:${candidate.targetSha}`;
    setResolvingCandidateKey(candidateKey);
    try {
      const changed = await agentClient.resolveLocalCommitAcceptance(
        workspaceId,
        candidate.gitRef,
        candidate.sourceSha,
        candidate.targetSha,
        accepted
      );
      if (changed) {
        await queryClient.invalidateQueries({ queryKey: ['local-commit-graph', workspaceId] });
      }
      addToast({
        title: accepted ? 'Commit Marked Merged' : 'Possible Match Dismissed',
        description: accepted
          ? 'Agentree will retain this source-to-landed mapping while the landed commit remains reachable.'
          : 'The generated commit remains unmerged.',
        variant: accepted ? 'success' : 'info',
      });
    } catch (error) {
      addToast({
        title: 'Could Not Save Decision',
        description: error instanceof Error ? error.message : 'The acceptance decision could not be saved.',
        variant: 'error',
      });
    } finally {
      setResolvingCandidateKey(null);
    }
  }, [addToast, pendingAcceptanceCandidates, queryClient, workspaceId]);

  const branchPointerByRef = useMemo(() => {
    return new Map(branches.map((branch) => [branch.git_ref, branch]));
  }, [branches]);

  const messageByCommit = useMemo(() => {
    const sorted = [...messages].sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.createdAt).getTime();
      const bTime = new Date(b.updatedAt || b.createdAt).getTime();
      return bTime - aTime;
    });
    const map = new Map<string, typeof sorted[number]>();
    for (const message of sorted) {
      const sha = getMessageOutputCommitSha(message)?.trim();
      if (!sha || map.has(sha)) continue;
      map.set(sha, message);
    }
    return map;
  }, [messages]);

  const currentCheckout = useMemo(() => {
    const normalizedHead = currentHeadSha?.trim() || null;
    if (!normalizedHead) {
      return {
        kind: 'unknown' as const,
        label: 'No checkout',
        sublabel: 'Unable to resolve HEAD',
        title: 'Agentree could not resolve the current checkout for this repo.',
      };
    }

    const matchingBranch = localRefs.find((ref) =>
      ref.commit_sha === normalizedHead && ref.git_ref.startsWith('refs/heads/')
    ) || null;
    const matchingMessage = messageByCommit.get(normalizedHead) ?? null;
    const focusNodeId = matchingMessage?.id ?? (graphCommitShas.has(normalizedHead) ? normalizedHead : null);

    if (matchingBranch) {
      return {
        kind: 'branch' as const,
        label: matchingBranch.short_name,
        sublabel: normalizedHead.slice(0, 8),
        title: `${matchingBranch.short_name} (${normalizedHead})`,
        focusNodeId,
        gitRef: matchingBranch.git_ref,
      };
    }

    return {
      kind: 'detached' as const,
      label: normalizedHead.slice(0, 8),
      sublabel: 'Detached HEAD',
      title: `Detached HEAD at ${normalizedHead}`,
      focusNodeId,
      gitRef: null,
    };
  }, [currentHeadSha, graphCommitShas, localRefs, messageByCommit]);



  const importCurrentCheckout = useCallback(async () => {
    const normalizedHead = currentHeadSha?.trim();
    if (!workspaceId || !repoPath || !normalizedHead || isImportingCurrentCheckoutRef.current) return;

    isImportingCurrentCheckoutRef.current = true;
    setIsImportingCurrentCheckout(true);
    const progressToastId = addToast({
      title: 'Importing Checkout',
      description: 'Importing HEAD and its ancestors into the graph.',
      variant: 'info',
      persistent: true,
      action: {
        component: (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            <span>Import in progress</span>
          </div>
        ),
      },
    });

    try {
      const commits = await agentClient.listMissingCommits(repoPath, null, normalizedHead);
      if (commits.length === 0) {
        throw new Error('No commits were found for the current checkout.');
      }

      const existingHead = messageByCommit.get(normalizedHead) ?? null;
      let importedCount = 0;
      if (!existingHead) {
        importedCount = await agentClient.importLocalCommits(
          workspaceId,
          commits.map((commit) => ({
            sha: commit.sha,
            parents: commit.parents,
            subject: commit.subject,
            authorName: commit.author_name ?? null,
            authorEmail: commit.author_email ?? null,
            authoredAt: commit.authored_at ?? null,
            committedAt: commit.authored_at ?? null,
            sourceKind: 'external',
            producedByNodeId: null,
            filesChangedCount: commit.files_changed_count ?? null,
            totalAdditions: commit.total_additions ?? null,
            totalDeletions: commit.total_deletions ?? null,
          })),
          currentCheckout.gitRef ?? null,
          repoPath
        );
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['graph-snapshot', workspaceId], refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: ['local-commits', workspaceId], refetchType: 'active' }),
        queryClient.invalidateQueries({ queryKey: trackedRefKeys.workspace(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: branchKeys.workspace(workspaceId) }),
      ]);

      if (existingHead?.id || importedCount > 0 || graphCommitShas.has(normalizedHead)) {
        setComposerBaseCommitOverride({
          workspaceId,
          commitSha: normalizedHead,
          label: currentCheckout.label,
          source: 'graph-header',
        });
      }

      removeToast(progressToastId);
      addToast({
        title: importedCount > 0 ? 'Checkout Imported' : 'Checkout Already Imported',
        description: importedCount > 0
          ? `Imported ${importedCount} ${importedCount === 1 ? 'commit' : 'commits'} into the graph.`
          : 'The current checkout now maps to an existing graph node.',
        variant: 'success',
      });
    } catch (error) {
      removeToast(progressToastId);
      addToast({
        title: 'Import Failed',
        description: error instanceof Error ? error.message : 'Unable to import the current checkout.',
        variant: 'error',
        duration: 8000,
      });
    } finally {
      isImportingCurrentCheckoutRef.current = false;
      setIsImportingCurrentCheckout(false);
    }
  }, [
    addToast,
    currentCheckout.gitRef,
    currentCheckout.label,
    currentHeadSha,
    messageByCommit,
    queryClient,
    removeToast,
    repoPath,
    setComposerBaseCommitOverride,
    workspaceId,
  ]);

  const focusTrackedRef = (gitRef: string) => {
    const trackedRef = trackedRefs.find((ref) => ref.git_ref === gitRef);
    const trackedCommitSha = trackedRef?.last_seen_commit_sha?.trim() || null;
    const branch = branchPointerByRef.get(gitRef);
    const commitSha = trackedCommitSha ?? getBranchPointerCommitSha(branch);
    if (!commitSha || !workspaceId) return;
    setComposerBaseCommitOverride({
      workspaceId,
      commitSha,
      label: trackedRef?.display_name ?? branch?.name ?? gitRef,
      source: 'graph-header',
    });
  };

  const focusCurrentCheckout = () => {
    if (!currentCheckout.focusNodeId) {
      let checkoutToastId = '';
      checkoutToastId = addToast({
        title: 'Checkout Not In Graph Yet',
        description: 'The current checkout does not map to an imported commit node yet.',
        variant: 'warning',
        action: {
          label: isImportingCurrentCheckout ? 'importing...' : 'import now',
          onClick: () => {
            removeToast(checkoutToastId);
            void importCurrentCheckout();
          },
        },
        duration: 10000,
      });
      return;
    }
    const commitSha = currentHeadSha?.trim() || null;
    if (!commitSha || !workspaceId) return;
    setComposerBaseCommitOverride({
      workspaceId,
      commitSha,
      label: currentCheckout.label,
      source: 'graph-header',
    });
  };

  const trackRef = useCallback((gitRef: string) => {
    if (!gitRef || !workspaceId) {
      setSelectedRef('');
      return;
    }
    setSelectedRef(gitRef);
    createTrackedRef.mutate({
      workspaceId,
      gitRef,
      displayName: gitRef.replace('refs/heads/', '').replace('refs/agentree/pointers/', ''),
      enabled: true,
    }, {
      onSuccess: () => setIsTrackBranchPickerOpen(false),
      onSettled: () => setSelectedRef(''),
    });
  }, [createTrackedRef, workspaceId]);

  if (!workspaceId || !repoPath || !shouldShowWorkspaceFeatures()) {
    return null;
  }

  return (
    <div className={cn('flex flex-row items-center w-full gap-3 border-b border-border/40 bg-background/95 px-3 py-1.5 backdrop-blur-md', className)}>
      {/* 1. Checked Out Zone */}
      <HoverCard openDelay={500}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            className={cn(
              "group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 transition-all text-left",
              currentHeadSha?.trim() && selectedComposerCommitSha === currentHeadSha.trim()
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/50 hover:bg-emerald-500/15"
                : currentCheckout.kind === 'unknown'
                ? "bg-muted/40 text-muted-foreground border border-border/50"
                : "bg-blue-500/10 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 border border-blue-500/30 hover:bg-blue-500/20"
            )}
            aria-label={`Focus currently checked out ${currentCheckout.title}`}
            onClick={focusCurrentCheckout}
          >
            {currentCheckout.kind === 'branch' ? <Compass size={12} className="shrink-0" /> : <GitCommitHorizontal size={12} className="shrink-0" />}
            <span className="text-[11px] font-semibold tracking-tight truncate max-w-[150px]">
              {currentCheckout.label}
            </span>
            {currentCheckout.sublabel !== 'Detached HEAD' && (
              <span className="text-[10px] opacity-70 truncate max-w-[80px]">({currentCheckout.sublabel})</span>
            )}
          </button>
        </HoverCardTrigger>
        <HoverCardContent className="w-64 rounded-xl border border-border/70 bg-popover px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-lg">
          Currently checked out: {currentCheckout.title}. Click to focus this node in the graph.
        </HoverCardContent>
      </HoverCard>

      {/* Vertical Divider */}
      <div className="w-px h-4 bg-border/60 shrink-0" />

      {/* 2. Tracked References Zone */}
      <div className="flex flex-1 items-center gap-1.5 overflow-x-auto custom-scrollbar min-w-0 pr-2">
        <HoverCard openDelay={500}>
          <HoverCardTrigger asChild>
            <div className="flex items-center gap-1 mr-1 cursor-help shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70 shrink-0">Tracked</span>
            </div>
          </HoverCardTrigger>
          <HoverCardContent className="w-64 rounded-xl border border-border/70 bg-popover px-3 py-2 text-xs leading-relaxed text-muted-foreground shadow-lg">
            Agentree continuously checks tracked branches and imports new commits when their refs move.
          </HoverCardContent>
        </HoverCard>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 rounded-md bg-emerald-500/8 px-2 text-[10.5px] font-semibold text-emerald-800 shadow-[0_0_0_1px_rgba(16,185,129,0.18),0_1px_2px_rgba(15,23,42,0.05)] transition-[background-color,box-shadow,scale] duration-150 hover:bg-emerald-500/13 hover:shadow-[0_0_0_1px_rgba(16,185,129,0.28),0_2px_4px_rgba(15,23,42,0.07)] active:scale-[0.96] dark:bg-emerald-500/10 dark:text-emerald-300"
              title="Choose which tracked branches count changes as merged"
            >
              <GitMerge size={12} className="shrink-0" />
              <span>Acceptance</span>
              <span className="min-w-4 rounded-full bg-emerald-600/12 px-1 font-mono text-[9px] tabular-nums dark:bg-emerald-400/15">
                {acceptanceBranchCount}
              </span>
              {pendingAcceptanceCandidates.length > 0 && (
                <span
                  className="min-w-4 rounded-full bg-amber-500/16 px-1 font-mono text-[9px] tabular-nums text-amber-800 dark:text-amber-300"
                  title={`${pendingAcceptanceCandidates.length} possible ${pendingAcceptanceCandidates.length === 1 ? 'match needs' : 'matches need'} review`}
                >
                  {pendingAcceptanceCandidates.length}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={7}
            className="w-[min(23rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-2 shadow-xl backdrop-blur-xl"
          >
            <div className="flex items-start gap-3 px-2 pb-2 pt-1">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold text-foreground">Acceptance branches</div>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground text-pretty">
                  A generated commit is merged when Agentree finds it in any enabled branch. Checks run automatically when Git refs move.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 rounded-lg text-muted-foreground transition-[background-color,color,transform] hover:text-foreground active:scale-[0.94]"
                onClick={onRefreshGitState}
                disabled={isRefreshingGitState || !repoPath}
                aria-label="Refresh Git acceptance state"
                title="Refresh Git state now"
              >
                <RefreshCw size={13} className={cn(isRefreshingGitState && 'animate-spin')} />
              </Button>
            </div>
            <div className="max-h-[17rem] space-y-1 overflow-y-auto overscroll-contain pr-0.5 custom-scrollbar">
              {trackedRefs.length === 0 ? (
                <div className="rounded-lg bg-muted/35 px-3 py-3 text-[11px] text-muted-foreground">
                  Track main, master, or another integration branch first.
                </div>
              ) : trackedRefs.map((ref) => {
                const canAccept = canBeAcceptanceGitRef(ref.git_ref);
                const countsAsMerged = ref.enabled && trackedRefCountsAsMerged(ref);
                const switchId = `acceptance-${ref.id}`;
                return (
                  <label
                    key={ref.id}
                    htmlFor={switchId}
                    className={cn(
                      'flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-2 transition-[background-color,color] duration-150',
                      canAccept ? 'cursor-pointer hover:bg-accent/70' : 'cursor-not-allowed opacity-55'
                    )}
                  >
                    <span className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-md',
                      countsAsMerged
                        ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                        : 'bg-muted/55 text-muted-foreground'
                    )}>
                      <GitBranch size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-semibold text-foreground">{ref.display_name}</span>
                      <span className="block truncate font-mono text-[9.5px] text-muted-foreground">{ref.git_ref}</span>
                      {!canAccept && (
                        <span className="mt-0.5 block text-[9.5px] text-muted-foreground">HEAD follows the checkout; choose a named branch.</span>
                      )}
                    </span>
                    <Switch
                      id={switchId}
                      checked={countsAsMerged}
                      disabled={!workspaceId || !canAccept || updateTrackedRef.isPending}
                      aria-label={`Count ${ref.display_name} as an acceptance branch`}
                      onCheckedChange={(checked) => {
                        if (!workspaceId || !canAccept) return;
                        updateTrackedRef.mutate({
                          workspaceId,
                          refId: ref.id,
                          isAcceptanceBranch: checked,
                        });
                      }}
                    />
                  </label>
                );
              })}
            </div>
            {pendingAcceptanceCandidates.length > 0 && (
              <div className="mt-2 border-t border-amber-500/20 px-2 pt-2">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10.5px] font-semibold text-amber-800 dark:text-amber-300">Possible matches</span>
                  <span className="rounded-full bg-amber-500/12 px-1.5 font-mono text-[9px] tabular-nums text-amber-800 dark:text-amber-300">
                    {pendingAcceptanceCandidates.length}
                  </span>
                </div>
                <p className="mb-2 text-[9.5px] leading-relaxed text-muted-foreground">
                  Content changed while landing. Confirm only if this is the accepted version.
                </p>
                <div className="max-h-40 space-y-1.5 overflow-y-auto custom-scrollbar">
                  {pendingAcceptanceCandidates.map((candidate) => {
                    const candidateKey = `${candidate.gitRef}:${candidate.sourceSha}:${candidate.targetSha}`;
                    const isResolving = resolvingCandidateKey === candidateKey;
                    return (
                      <div key={candidateKey} className="rounded-lg border border-amber-500/20 bg-amber-500/[0.045] p-2">
                        <div className="truncate text-[11px] font-semibold text-foreground">
                          {candidate.subject?.trim() || candidate.sourceSha.slice(0, 8)}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground">
                          {candidate.sourceSha.slice(0, 8)} → {candidate.targetSha.slice(0, 8)} · {candidate.gitRef.replace(/^refs\/(heads|remotes)\//, '')}
                        </div>
                        <div className="mt-2 flex justify-end gap-1.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-md px-2 text-[10px] text-muted-foreground"
                            disabled={Boolean(resolvingCandidateKey)}
                            onClick={() => void resolveAcceptanceCandidate(candidate, false)}
                          >
                            Dismiss
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 rounded-md bg-emerald-600 px-2 text-[10px] text-white hover:bg-emerald-700"
                            disabled={Boolean(resolvingCandidateKey)}
                            onClick={() => void resolveAcceptanceCandidate(candidate, true)}
                          >
                            {isResolving ? <Loader2 size={11} className="mr-1 animate-spin" /> : <Check size={11} className="mr-1" />}
                            Mark merged
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="mt-2 border-t border-border/60 px-2 pb-1 pt-2">
              <label htmlFor="show-merged-agentree-commits" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1">
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] font-semibold text-foreground">Show merged commits</span>
                  <span className="mt-0.5 block text-[9.5px] leading-relaxed text-muted-foreground">
                    Off keeps the graph focused on changes that still need acceptance.
                  </span>
                </span>
                <Switch
                  id="show-merged-agentree-commits"
                  checked={showMergedCommits}
                  aria-label="Show merged Agentree commits"
                  onCheckedChange={onShowMergedCommitsChange}
                />
              </label>
            </div>
          </PopoverContent>
        </Popover>

        {trackedRefs.length === 0 && (
          <span className="text-[10.5px] text-muted-foreground/50 italic mr-2">None selected</span>
        )}

        {trackedRefs.map((ref) => {
          const pointerCommitSha = ref.last_seen_commit_sha?.trim() || getBranchPointerCommitSha(branchPointerByRef.get(ref.git_ref));
          const isSelectedForComposer = !!pointerCommitSha && pointerCommitSha === selectedComposerCommitSha;
          const countsAsMerged = ref.enabled && trackedRefCountsAsMerged(ref);
          return (
            <div
              key={ref.id}
              className={cn(
                "group flex shrink-0 items-center rounded-full border bg-background px-1.5 py-0.5 text-[10px] font-medium transition-[background-color,border-color,color] duration-150",
                isSelectedForComposer
                  ? "border-emerald-500/70 text-emerald-700 bg-emerald-500/10 dark:text-emerald-300"
                  : countsAsMerged
                    ? "border-emerald-500/35 bg-emerald-500/5 text-emerald-800 hover:bg-emerald-500/10 dark:text-emerald-300"
                    : "border-border/60 text-foreground/80 hover:border-border hover:bg-muted/30"
              )}
            >
              <button
                type="button"
                className="truncate max-w-[120px] px-1 hover:underline outline-none"
                title={ref.git_ref}
                onClick={() => focusTrackedRef(ref.git_ref)}
              >
                {countsAsMerged && <GitMerge size={9} className="mr-1 inline shrink-0" />}
                {ref.display_name}
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="h-4 w-4 rounded-full p-0 ml-0.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-opacity outline-none focus:opacity-100"
                disabled={deleteTrackedRef.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!workspaceId) return;
                  deleteTrackedRef.mutate({ workspaceId, refId: ref.id });
                }}
                title="Stop tracking"
              >
                <X size={10} />
              </Button>
            </div>
          );
        })}

        {/* Track New Branch Selector */}
        <div className="flex shrink-0 items-center gap-1 ml-1 border-l border-border/40 pl-2">
          <Popover open={isTrackBranchPickerOpen} onOpenChange={setIsTrackBranchPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 min-w-[8.5rem] justify-between gap-2 rounded-md border border-border/50 bg-muted/35 px-2 text-[10.5px] font-semibold text-muted-foreground shadow-[0_1px_0_rgba(255,255,255,0.7)_inset] transition-[background-color,border-color,color,transform] hover:border-border hover:bg-muted/55 hover:text-foreground active:scale-[0.96] dark:bg-slate-900/80 dark:shadow-none dark:hover:bg-slate-800/90"
                disabled={createTrackedRef.isPending || trackableRefs.length === 0}
                title={trackableRefs.length === 0 ? 'No untracked branches available' : 'Track a branch'}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  {createTrackedRef.isPending ? (
                    <Loader2 size={12} className="shrink-0 animate-spin" />
                  ) : (
                    <GitBranch size={12} className="shrink-0" />
                  )}
                  <span className="truncate">Track branch</span>
                </span>
                <ChevronDown size={12} className="shrink-0 opacity-65" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={6}
              className="w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border/70 bg-popover/95 p-1.5 shadow-xl backdrop-blur-xl"
            >
              <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Newest branch tips
              </div>
              <div className="max-h-[18rem] overflow-y-auto overscroll-contain pr-0.5 custom-scrollbar">
                {trackableRefs.map((ref) => {
                  const isPending = selectedRef === ref.git_ref && createTrackedRef.isPending;
                  return (
                    <button
                      key={ref.git_ref}
                      type="button"
                      className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-[background-color,color] hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                      disabled={createTrackedRef.isPending}
                      onClick={() => trackRef(ref.git_ref)}
                    >
                      {isPending ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-semibold text-foreground">
                          {ref.short_name}
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="font-mono tabular-nums">{shortCommitSha(ref.commit_sha)}</span>
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <Clock3 size={10} className="shrink-0" />
                            <span className="truncate">{formatCommitAge(ref.committed_at)}</span>
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}
