import { Files, GitCommitVertical, GitMerge, Minus, Plus } from 'lucide-react';
import type { ProjectedCommitEntity } from '../../../domain/workspaceProjection';
import { cn } from '../../../lib/utils';

const formatCommitDate = (value?: string | null): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
};

export function RichCommitRow({ commit }: { commit: ProjectedCommitEntity }) {
  const filesChanged = commit.commit.files_changed_count ?? 0;
  const additions = commit.commit.total_additions ?? 0;
  const deletions = commit.commit.total_deletions ?? 0;
  const parentCount = commit.parentShas.length;
  const authoredAt = formatCommitDate(commit.commit.authored_at ?? commit.commit.committed_at ?? commit.commit.createdAt);

  return (
    <div
      className="group/commit relative rounded-[8px] border border-zinc-200/80 bg-white/88 px-3 py-2.5 text-left shadow-[0_1px_0_rgba(255,255,255,0.85)_inset] transition-all duration-200 hover:-translate-y-px hover:border-emerald-300/85 hover:bg-white hover:shadow-[0_14px_28px_-22px_rgba(4,120,87,0.78)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 dark:border-zinc-800/80 dark:bg-zinc-950/72 dark:shadow-none dark:hover:border-emerald-700/80 dark:hover:bg-zinc-950"
      tabIndex={0}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/80 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-800/70">
          <GitCommitVertical size={12} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="shrink-0 font-mono text-[10px] leading-none text-emerald-800/85 dark:text-emerald-300/85">
              {commit.shortSha || commit.sha.slice(0, 7)}
            </span>
            {authoredAt ? <span className="shrink-0 text-[10px] font-medium leading-none text-zinc-500 dark:text-zinc-400">{authoredAt}</span> : null}
          </div>
          <p className="mt-1 text-[12px] font-semibold leading-snug text-zinc-900 text-pretty dark:text-zinc-100">
            {commit.subject}
          </p>
        </div>
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-200/80 pt-2 text-[10px] font-medium leading-none text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-400">
        {parentCount > 1 ? (
          <span className="inline-flex items-center gap-1" title={`${parentCount} parents`}>
            <GitMerge size={10} />
            {parentCount}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1" title={`${filesChanged} files changed`}>
          <Files size={10} />
          {filesChanged}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1',
            additions > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 dark:text-zinc-500',
          )}
          title={`${additions} added lines`}
        >
          <Plus size={10} />
          {additions}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1',
            deletions > 0 ? 'text-red-500 dark:text-red-400' : 'text-zinc-400 dark:text-zinc-500',
          )}
          title={`${deletions} deleted lines`}
        >
          <Minus size={10} />
          {deletions}
        </span>
      </div>
    </div>
  );
}
