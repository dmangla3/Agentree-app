import { Files, FileMinus, FilePlus, GitMerge } from 'lucide-react';
import type { CommitStats } from '../../../lib/graph/commitStats';

interface CommitStatsFooterProps {
  stats: CommitStats;
  parentCount: number;
}

export const CommitStatsFooter = ({ stats, parentCount }: CommitStatsFooterProps) => (
  <div className="flex w-full items-center justify-start gap-1.5 border-t border-emerald-300/40 pt-1 text-[8px] leading-none text-zinc-600 dark:border-emerald-800/70 dark:text-zinc-400">
    {parentCount > 1 && (
      <span className="flex items-center gap-0.5" title={`${parentCount} parents`}>
        <GitMerge size={8} />
        {parentCount}
      </span>
    )}
    {stats.filesChanged > 0 && (
      <span className="flex items-center gap-0.5" title={`${stats.filesChanged} files changed`}>
        <Files size={8} className="text-emerald-500" />
        {stats.filesChanged}
      </span>
    )}
    {stats.totalAdditions > 0 && (
      <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400" title={`${stats.totalAdditions} added lines`}>
        <FilePlus size={8} />
        {stats.totalAdditions}
      </span>
    )}
    {stats.totalDeletions > 0 && (
      <span className="flex items-center gap-0.5 text-red-500 dark:text-red-400" title={`${stats.totalDeletions} deleted lines`}>
        <FileMinus size={8} />
        {stats.totalDeletions}
      </span>
    )}
  </div>
);
