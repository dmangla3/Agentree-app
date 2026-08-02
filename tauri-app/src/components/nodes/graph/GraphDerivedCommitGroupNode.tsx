import { memo } from 'react';
import { Layers3, GitCommitVertical } from 'lucide-react';
import type { ProjectedCommitGroup, WorkspaceProjection } from '../../../domain/workspaceProjection';
import { cn } from '../../../lib/utils';

interface GraphDerivedCommitGroupNodeProps {
  group: ProjectedCommitGroup;
  projection?: WorkspaceProjection;
  isFocused?: boolean;
  isSelected?: boolean;
}

const sourceLabelByKind: Record<ProjectedCommitGroup['sourceKind'], string> = {
  external: 'Import',
  manual: 'Manual',
  unknown: 'Commits',
};

export const GraphDerivedCommitGroupNode = memo(({
  group,
  projection,
  isFocused = false,
  isSelected = false,
}: GraphDerivedCommitGroupNodeProps) => {
  const commits = group.commitShas
    .map((sha) => projection?.commitBySha.get(sha))
    .filter(Boolean);
  const first = projection?.commitBySha.get(group.firstSha);
  const last = projection?.commitBySha.get(group.lastSha);
  const label = sourceLabelByKind[group.sourceKind];

  return (
    <div
      className={cn(
        'relative h-full w-[120px] rounded-l-[2px] rounded-r-[7px] border border-emerald-300/70 bg-emerald-50/95 px-2.5 py-2 text-emerald-950 shadow-sm dark:border-emerald-800/75 dark:bg-emerald-950/35 dark:text-emerald-100',
        isFocused && 'ring-2 ring-indigo-400/70',
        isSelected && 'ring-2 ring-emerald-400/80',
      )}
      title={`${group.commitShas.length} ${label.toLowerCase()} commits: ${group.firstSha.slice(0, 8)}..${group.lastSha.slice(0, 8)}`}
    >
      <div className="pointer-events-none absolute inset-y-2 left-[7px] w-px bg-emerald-300/70 dark:bg-emerald-800/80" />
      <div className="pointer-events-none absolute inset-x-2 bottom-[-5px] h-5 rounded-[7px] border border-emerald-200/80 bg-emerald-100/70 dark:border-emerald-900/80 dark:bg-emerald-950/70" />
      <div className="pointer-events-none absolute inset-x-3 bottom-[-10px] h-5 rounded-[7px] border border-emerald-200/60 bg-emerald-100/45 dark:border-emerald-900/60 dark:bg-emerald-950/45" />

      <div className="relative flex h-full min-h-0 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-1">
          <Layers3 size={12} className="text-emerald-700 dark:text-emerald-300" />
          <span className="truncate text-[8px] font-semibold uppercase tracking-[0.08em] text-emerald-800 dark:text-emerald-300">
            {label}
          </span>
        </div>

        <div className="rounded-[5px] border border-emerald-200/75 bg-white/70 px-1.5 py-1 text-center font-mono text-[9px] leading-none text-emerald-900 dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-200">
          {group.firstSha.slice(0, 6)}..{group.lastSha.slice(0, 6)}
        </div>

        <div className="flex flex-1 flex-col justify-center gap-1 overflow-hidden">
          {(commits.length > 0 ? commits : [first, last].filter(Boolean)).slice(0, 3).map((commit) => (
            <div key={commit!.sha} className="flex items-center gap-1 truncate text-[9px] leading-tight text-zinc-700 dark:text-zinc-300">
              <GitCommitVertical size={9} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span className="truncate">{commit!.subject}</span>
            </div>
          ))}
        </div>

        <div className="border-t border-emerald-300/50 pt-1 text-[8px] font-semibold leading-none text-emerald-700 dark:border-emerald-800/80 dark:text-emerald-300">
          {group.commitShas.length} commits
        </div>
      </div>
    </div>
  );
});

GraphDerivedCommitGroupNode.displayName = 'GraphDerivedCommitGroupNode';
