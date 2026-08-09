import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitCommitHorizontal, Compass, X, Loader2 } from 'lucide-react';
import { agentClient } from '../lib/agentClient';
import { useCreateTrackedRef, useDeleteTrackedRef, useTrackedRefs, trackedRefKeys } from '../hooks/useTrackedRefs';
import { branchKeys, useBranches } from '../hooks/useBranches';
import { useCurrentHead } from '../hooks/useCurrentHead';
import { useMessages } from '../hooks/useMessages';
import { shouldShowWorkspaceFeatures } from '../hooks/useTauriWorkspace';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { Button } from '../../@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../@/components/ui/hover-card';
import { cn } from '../lib/utils';
import { useToast } from './Toast';
import { getBranchPointerCommitSha, getMessageOutputCommitSha } from '../lib/graph/commitAccessors';

interface TrackedBranchesPanelProps {
  workspaceId: string | null;
  repoPath: string | null;
  className?: string;
}

export function TrackedBranchesPanel({ workspaceId, repoPath, className }: TrackedBranchesPanelProps) {
  const [selectedRef, setSelectedRef] = useState<string>('');
  const { data: trackedRefs = [] } = useTrackedRefs(workspaceId);
  const { data: branches = [] } = useBranches(workspaceId);
  const { data: currentHeadSha } = useCurrentHead(repoPath);
  const { data: messages = [] } = useMessages(workspaceId);
  const createTrackedRef = useCreateTrackedRef();
  const deleteTrackedRef = useDeleteTrackedRef();
  const {
    composerBaseCommitOverride,
    composerContextPreview,
    setComposerBaseCommitOverride,
  } = useWorkspaceStore();
  const { addToast, removeToast } = useToast();
  const queryClient = useQueryClient();
  const [isImportingCurrentCheckout, setIsImportingCurrentCheckout] = useState(false);
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
    return localRefs.filter((ref) => !trackedSet.has(ref.git_ref));
  }, [localRefs, trackedRefs]);

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
      description: 'Importing the checked-out commit and its ancestors into the graph.',
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

        {trackedRefs.length === 0 && (
          <span className="text-[10.5px] text-muted-foreground/50 italic mr-2">None selected</span>
        )}

        {trackedRefs.map((ref) => {
          const pointerCommitSha = ref.last_seen_commit_sha?.trim() || getBranchPointerCommitSha(branchPointerByRef.get(ref.git_ref));
          const isSelectedForComposer = !!pointerCommitSha && pointerCommitSha === selectedComposerCommitSha;
          return (
            <div
              key={ref.id}
              className={cn(
                "group flex shrink-0 items-center rounded-full border bg-background px-1.5 py-0.5 text-[10px] font-medium transition-all",
                isSelectedForComposer ? "border-emerald-500/70 text-emerald-700 bg-emerald-500/10 dark:text-emerald-300" : "border-border/60 text-foreground/80 hover:border-border hover:bg-muted/30"
              )}
            >
              <button
                type="button"
                className="truncate max-w-[120px] px-1 hover:underline outline-none"
                title={ref.git_ref}
                onClick={() => focusTrackedRef(ref.git_ref)}
              >
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
          <select
            className="h-5 flex-1 cursor-pointer rounded border border-border/40 bg-muted/30 px-1 text-[10px] font-medium text-muted-foreground outline-none transition-colors [color-scheme:light] hover:bg-muted/45 hover:text-foreground focus:border-primary/40 dark:bg-slate-900/80 dark:text-slate-300 dark:[color-scheme:dark] dark:hover:bg-slate-800/90 dark:hover:text-slate-50 w-auto"
            value={selectedRef}
            onChange={(event) => {
              const val = event.target.value;
              if (!val || !workspaceId) {
                setSelectedRef('');
                return;
              }
              setSelectedRef(val);
              createTrackedRef.mutate({
                workspaceId,
                gitRef: val,
                displayName: val.replace('refs/heads/', '').replace('refs/agentree/pointers/', ''),
                enabled: true,
              }, {
                onSuccess: () => setSelectedRef(''),
              });
            }}
          >
            <option value="" className="bg-popover text-popover-foreground">+ Track Branch</option>
            {trackableRefs.map((ref) => (
              <option key={ref.git_ref} value={ref.git_ref} className="bg-popover text-popover-foreground">
                {ref.short_name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
