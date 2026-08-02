import { memo } from 'react';
import { CircleDot, Files, GitMerge } from 'lucide-react';
import type { ProjectedCommitEntity } from '../../../domain/workspaceProjection';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';
import { cn } from '../../../lib/utils';

interface GraphCanonicalCommitNodeProps {
  commit: ProjectedCommitEntity;
  isFocused?: boolean;
  isSelected?: boolean;
}

const sourceLabel = (commit: ProjectedCommitEntity): string => {
  if (commit.kind === 'manual_commit') return 'Manual';
  if (commit.kind === 'imported_commit') return 'Import';
  if (commit.kind === 'merge_commit') return 'Merge';
  if (commit.kind === 'generated_commit') return 'Gen';
  return 'Commit';
};

export const GraphCanonicalCommitNode = memo(({
  commit,
  isFocused = false,
  isSelected = false,
}: GraphCanonicalCommitNodeProps) => {
  const parentCount = commit.parentShas.length;
  const isMergeCommit = parentCount > 1;
  const filesChanged = commit.commit.files_changed_count ?? 0;

  return (
    <div
      className={cn(
        'relative flex h-full w-[120px] flex-col gap-1.5 rounded-l-[2px] rounded-r-[7px] border border-emerald-300/65 bg-emerald-50/90 px-2.5 py-2 text-emerald-950 shadow-none dark:border-emerald-800/70 dark:bg-emerald-950/25 dark:text-emerald-100',
        isFocused && 'ring-2 ring-indigo-400/70',
        isSelected && 'ring-2 ring-emerald-400/80',
      )}
      title={commit.sha}
    >
      <div className="absolute left-[-2px] top-0 h-full w-[3px] rounded-l-[2px] bg-emerald-500/70 dark:bg-emerald-500/60" />
      <div className="pointer-events-none absolute inset-y-2 left-[7px] w-px bg-emerald-300/55 dark:bg-emerald-800/70" />

      <div className="flex items-center justify-between gap-1.5">
        <CircleDot size={7} className="shrink-0 text-emerald-700 dark:text-emerald-400" strokeWidth={2.2} />
        <span className="min-w-0 truncate text-[8px] font-semibold uppercase tracking-[0.08em] text-emerald-800 dark:text-emerald-300">
          {sourceLabel(commit)}
        </span>
      </div>

      <div className="flex w-full items-center justify-between gap-1 rounded-[5px] border border-emerald-200/65 bg-white/60 px-1.5 py-1 font-mono text-[9px] leading-none text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/55 dark:text-emerald-200">
        <span className="min-w-0 truncate">{commit.shortSha}</span>
        <CopyCommitShaButton commitSha={commit.sha} className="h-3.5 w-3.5 shrink-0 text-emerald-700/70 dark:text-emerald-300/70" />
      </div>

      <p className="min-h-0 flex-1 text-left text-[11px] font-semibold leading-snug text-zinc-800 line-clamp-4 dark:text-zinc-200">
        {commit.subject}
      </p>

      <div className="flex items-center gap-1.5 border-t border-emerald-300/40 pt-1 text-[8px] leading-none text-zinc-600 dark:border-emerald-800/70 dark:text-zinc-400">
        {isMergeCommit && (
          <span className="flex items-center gap-0.5" title={`${parentCount} parents`}>
            <GitMerge size={8} />
            {parentCount}
          </span>
        )}
        {filesChanged > 0 && (
          <span className="flex items-center gap-0.5" title={`${filesChanged} files changed`}>
            <Files size={8} className="text-emerald-500" />
            {filesChanged}
          </span>
        )}
      </div>
    </div>
  );
});

GraphCanonicalCommitNode.displayName = 'GraphCanonicalCommitNode';
