import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, GitBranch, GitCommitHorizontal, Loader2, Search, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../@/components/ui/dialog';
import { Button } from '../../@/components/ui/button';
import { Input } from '../../@/components/ui/input';
import { ScrollArea } from '../../@/components/ui/scroll-area';
import { Badge } from '../../@/components/ui/badge';
import { agentClient, type AddableCommitCandidate, type GitCommitMetadata } from '../lib/agentClient';
import { buildMessageMap, resolveNodeCommit } from '../lib/gitNodeUtils';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import { Message } from '../stores/workspaceStore';
import { useTrackedRefs } from '../hooks/useTrackedRefs';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '../lib/utils';

interface AddCommitDialogProps {
  open: boolean;
  workspaceId: string | null;
  repoPath: string | null;
  baseCommitSha?: string | null;
  parentNodeId: string | null;
  messages: Message[];
  onOpenChange: (open: boolean) => void;
}

const shortSha = (sha: string | null | undefined) => (sha || '').slice(0, 8);

const getCandidateLabel = (candidate: AddableCommitCandidate): string => {
  const preferredRef =
    candidate.refs.find((ref) => ref.is_current_branch) ||
    candidate.refs.find((ref) => ref.kind === 'branch') ||
    candidate.refs[0] ||
    null;
  if (candidate.is_head && !preferredRef) return 'HEAD';
  return preferredRef?.short_name || shortSha(candidate.sha);
};

async function enrichCommitRangeWithDiffStats(
  repoPath: string,
  range: GitCommitMetadata[]
): Promise<GitCommitMetadata[]> {
  const enriched = [...range];
  let nextIndex = 0;
  const workerCount = Math.min(6, range.length);

  async function worker() {
    while (nextIndex < range.length) {
      const index = nextIndex;
      nextIndex += 1;
      const commit = range[index];
      const parent = commit.parents[0] ?? null;
      if (!parent) {
        enriched[index] = {
          ...commit,
          files_changed_count: commit.files_changed_count ?? 0,
          files_added: commit.files_added ?? 0,
          files_modified: commit.files_modified ?? 0,
          files_deleted: commit.files_deleted ?? 0,
          total_additions: commit.total_additions ?? 0,
          total_deletions: commit.total_deletions ?? 0,
        };
        continue;
      }

      try {
        const diff = await agentClient.diffCommits(repoPath, parent, commit.sha, false);
        enriched[index] = {
          ...commit,
          files_changed_count: diff.files.length,
          files_added: diff.stats.files_added,
          files_modified: diff.stats.files_modified,
          files_deleted: diff.stats.files_deleted,
          total_additions: diff.stats.total_additions,
          total_deletions: diff.stats.total_deletions,
        };
      } catch {
        enriched[index] = commit;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return enriched;
}

export function AddCommitDialog({
  open,
  workspaceId,
  repoPath,
  baseCommitSha,
  parentNodeId,
  messages,
  onOpenChange,
}: AddCommitDialogProps) {
  const queryClient = useQueryClient();
  const { data: trackedRefs = [] } = useTrackedRefs(open ? workspaceId : null);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<AddableCommitCandidate[]>([]);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messageMap = useMemo(() => buildMessageMap(messages), [messages]);
  const parentMessage = parentNodeId ? messageMap.get(parentNodeId) ?? null : null;
  const baseCommit = useMemo(
    () => resolveNodeCommit(parentMessage, messageMap, baseCommitSha ?? null),
    [baseCommitSha, messageMap, parentMessage]
  );
  const knownGraphCommits = useMemo(() => {
    const childIds = new Set(messages.map((message) => message.parentId).filter((id): id is string => Boolean(id)));
    const edgeCommits = messages
      .filter((message) => !childIds.has(message.id))
      .map((message) => getMessageOutputCommitSha(message))
      .filter((sha): sha is string => Boolean(sha));
    const recentCommits = [...messages]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map((message) => getMessageOutputCommitSha(message))
      .filter((sha): sha is string => Boolean(sha))
      .slice(0, 80);
    return Array.from(new Set([...edgeCommits, ...recentCommits]));
  }, [messages]);
  const trackedRefSet = useMemo(
    () => new Set(trackedRefs.filter((ref) => ref.enabled).map((ref) => ref.git_ref)),
    [trackedRefs]
  );

  const rankedCandidates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...candidates]
      .filter((candidate) => {
        if (!normalizedQuery) return true;
        const labels = [
          candidate.sha,
          candidate.subject,
          ...candidate.refs.map((ref) => ref.short_name),
          ...candidate.refs.map((ref) => ref.git_ref),
        ].join(' ').toLowerCase();
        return labels.includes(normalizedQuery);
      })
      .sort((left, right) => {
        const leftTracked = left.refs.some((ref) => trackedRefSet.has(ref.git_ref)) ? 0 : 1;
        const rightTracked = right.refs.some((ref) => trackedRefSet.has(ref.git_ref)) ? 0 : 1;
        return left.rank_group - right.rank_group
          || leftTracked - rightTracked
          || left.ahead_count - right.ahead_count
          || String(right.authored_at || '').localeCompare(String(left.authored_at || ''));
      });
  }, [candidates, query, trackedRefSet]);

  const selectedCandidate = useMemo(
    () => rankedCandidates.find((candidate) => candidate.sha === selectedSha) || candidates.find((candidate) => candidate.sha === selectedSha) || null,
    [candidates, rankedCandidates, selectedSha]
  );

  useEffect(() => {
    if (!open) {
      setQuery('');
      setCandidates([]);
      setSelectedSha(null);
      setError(null);
      return;
    }
    if (!repoPath || !baseCommit) {
      setError('This node does not have a code commit to add onto.');
      return;
    }

    let cancelled = false;
    setIsLoadingCandidates(true);
    setError(null);
    agentClient.listAddableCommitCandidates(repoPath, baseCommit, 80, knownGraphCommits)
      .then((nextCandidates) => {
        if (cancelled) return;
        setCandidates(nextCandidates);
        setSelectedSha(nextCandidates[0]?.sha ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load addable commits.');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingCandidates(false);
      });

    return () => {
      cancelled = true;
    };
  }, [baseCommit, knownGraphCommits, open, repoPath]);

  const handleSubmit = useCallback(async (candidateOverride?: AddableCommitCandidate) => {
    const candidate = candidateOverride ?? selectedCandidate;
    if (!workspaceId || !parentNodeId || !candidate || !baseCommit || !repoPath) return;
    const primaryRef = candidate.refs.find((ref) => ref.is_current_branch) || candidate.refs[0] || null;
    setIsSubmitting(true);
    setError(null);
    try {
      const range = await agentClient.listAddableCommitRange(repoPath, baseCommit, candidate.sha, 500);
      if (range.length === 0) {
        setError('No descendant commits are available for that selection.');
        return;
      }
      const enrichedRange = await enrichCommitRangeWithDiffStats(repoPath, range);
      await agentClient.importLocalCommits(
        workspaceId,
        enrichedRange.map((commit) => ({
          sha: commit.sha,
          parents: commit.parents,
          subject: commit.subject,
          authorName: commit.author_name ?? null,
          authorEmail: commit.author_email ?? null,
          authoredAt: commit.authored_at ?? null,
          committedAt: commit.authored_at ?? null,
          sourceKind: 'manual',
          producedByNodeId: null,
          filesChangedCount: commit.files_changed_count ?? null,
          totalAdditions: commit.total_additions ?? null,
          totalDeletions: commit.total_deletions ?? null,
        })),
        primaryRef?.git_ref ?? null
      );
      queryClient.invalidateQueries({ queryKey: ['graph-snapshot', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['local-commits', workspaceId] });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add commit.');
    } finally {
      setIsSubmitting(false);
    }
  }, [baseCommit, onOpenChange, parentNodeId, queryClient, repoPath, selectedCandidate, workspaceId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-border/60 bg-[#fbfaf7] p-0 shadow-[0_28px_80px_-36px_rgba(15,23,42,0.45),0_12px_28px_-20px_rgba(15,23,42,0.32)] dark:bg-slate-950">
        <div className="border-b border-border/60 bg-white/70 px-5 py-4 dark:bg-white/[0.03]">
        <DialogHeader>
          <DialogTitle>Add Commit</DialogTitle>
          <DialogDescription>
            Add descendant commits after the selected node as individual graph commits.
          </DialogDescription>
        </DialogHeader>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/80 px-3 py-2 shadow-[0_1px_0_rgba(255,255,255,0.92)_inset,0_8px_22px_-18px_rgba(15,23,42,0.45)] ring-1 ring-black/[0.06] dark:bg-white/[0.04] dark:ring-white/10">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <GitCommitHorizontal size={14} className="shrink-0" />
              <span className="shrink-0">Current code</span>
              <code className="truncate font-mono text-foreground">{shortSha(baseCommit)}</code>
            </div>
            {rankedCandidates.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {rankedCandidates.length} available
              </span>
            ) : null}
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search commits, branches, refs, or SHA"
              className="h-9 rounded-xl border-border/60 bg-white/85 pl-8 text-sm shadow-[0_1px_0_rgba(255,255,255,0.88)_inset] dark:bg-white/[0.04]"
            />
          </div>

          <ScrollArea className="h-[min(390px,calc(100dvh-18rem))] min-h-[180px] rounded-2xl bg-white/72 shadow-[0_1px_0_rgba(255,255,255,0.92)_inset,0_18px_44px_-34px_rgba(15,23,42,0.7)] ring-1 ring-black/[0.06] dark:bg-white/[0.035] dark:ring-white/10">
            <div className="p-2">
              {isLoadingCandidates ? (
                <div className="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  Loading addable commits...
                </div>
              ) : rankedCandidates.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                  <XCircle size={14} />
                  No descendant commits are available.
                </div>
              ) : rankedCandidates.map((candidate) => {
                const selected = candidate.sha === selectedSha;
                const label = getCandidateLabel(candidate);
                const isTracked = candidate.refs.some((ref) => trackedRefSet.has(ref.git_ref));
                const commitCountLabel = `${candidate.ahead_count} total ${candidate.ahead_count === 1 ? 'commit' : 'commits'} will be added`;
                return (
                  <button
                    key={candidate.sha}
                    type="button"
                    onClick={() => setSelectedSha(candidate.sha)}
                    onDoubleClick={() => {
                      setSelectedSha(candidate.sha);
                      void handleSubmit(candidate);
                    }}
                    className={cn(
                      'mb-1.5 grid w-full min-w-0 grid-cols-[minmax(0,1fr)_88px] items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none ring-1 transition-[background-color,box-shadow] duration-150',
                      selected
                        ? 'bg-emerald-50/90 shadow-[0_10px_26px_-20px_rgba(16,185,129,0.75),0_1px_0_rgba(255,255,255,0.92)_inset] ring-emerald-300/80 dark:bg-emerald-950/35 dark:ring-emerald-800/80'
                        : 'bg-[#fffefa]/78 shadow-[0_1px_0_rgba(255,255,255,0.9)_inset] ring-black/[0.05] hover:bg-white hover:shadow-[0_10px_24px_-22px_rgba(15,23,42,0.75),0_1px_0_rgba(255,255,255,0.9)_inset] hover:ring-black/[0.08] dark:bg-white/[0.035] dark:ring-white/10 dark:hover:bg-white/[0.06]'
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
                      <div className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg shadow-[0_1px_0_rgba(255,255,255,0.82)_inset] ring-1',
                        selected
                          ? 'bg-emerald-100 text-emerald-700 ring-emerald-300/70 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-800'
                          : 'bg-white text-muted-foreground ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/10'
                      )}>
                        {selected ? <Check size={14} /> : <GitBranch size={14} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate text-[13px] font-semibold leading-5 text-foreground">{label}</span>
                          {candidate.is_head ? <Badge className="h-4 shrink-0 rounded-md px-1.5 text-[9px]">HEAD</Badge> : null}
                          {isTracked ? <Badge variant="outline" className="h-4 shrink-0 rounded-md px-1.5 text-[9px]">Tracked</Badge> : null}
                        </div>
                        <div className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground">{candidate.subject}</div>
                        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-4 text-muted-foreground">
                          <code className="shrink-0 font-mono tabular-nums">{shortSha(candidate.sha)}</code>
                          {candidate.authored_at ? <span>{new Date(candidate.authored_at).toLocaleDateString()}</span> : null}
                          {candidate.author_name ? <span className="max-w-[180px] truncate">{candidate.author_name}</span> : null}
                        </div>
                      </div>
                    </div>
                    <div className="min-w-0 shrink-0 text-right">
                      <div className="text-[13px] font-semibold leading-5 tabular-nums text-foreground">
                        {candidate.ahead_count}
                      </div>
                      <div className="truncate text-[10px] leading-4 text-muted-foreground" title={commitCountLabel}>
                        {candidate.ahead_count === 1 ? 'commit' : 'commits'} added
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        {error ? <div className="mx-5 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

        <DialogFooter className="border-t border-border/60 bg-white/55 px-5 py-4 dark:bg-white/[0.025]">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!selectedCandidate || isSubmitting}>
            {isSubmitting ? <Loader2 size={14} className="mr-2 animate-spin" /> : null}
            {isSubmitting ? 'Adding...' : 'Add Commit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AddCommitDialog;
