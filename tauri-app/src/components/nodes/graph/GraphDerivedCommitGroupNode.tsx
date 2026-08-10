import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { GitCommitVertical, Layers3, Rows3 } from 'lucide-react';
import type { ProjectedCommitEntity, ProjectedCommitGroup, WorkspaceProjection } from '../../../domain/workspaceProjection';
import { cn } from '../../../lib/utils';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../../@/components/ui/hover-card';
import { RichCommitRow } from './GraphCommitHoverCard';

interface GraphDerivedCommitGroupNodeProps {
  group: ProjectedCommitGroup;
  projection?: WorkspaceProjection;
  isFocused?: boolean;
  isSelected?: boolean;
  isComposerBaseCommit?: boolean;
  onCommitSelectBase?: (commit: ProjectedCommitEntity) => void;
}

const sourceLabelByKind: Record<ProjectedCommitGroup['sourceKind'], string> = {
  external: 'Import',
  manual: 'Manual',
  unknown: 'Commits',
};

const isProjectedCommit = (commit: ProjectedCommitEntity | undefined | null): commit is ProjectedCommitEntity => (
  Boolean(commit)
);

function CompactCommitPreviewRow({ commit }: { commit: ProjectedCommitEntity }) {
  return (
    <div className="relative flex min-w-0 items-center gap-1 rounded-[5px] border border-white/55 bg-white/55 px-1.5 py-1 shadow-[0_1px_0_rgba(255,255,255,0.72)_inset] dark:border-emerald-800/45 dark:bg-emerald-950/38">
      <GitCommitVertical size={8} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
      <span className="min-w-0 truncate text-[9px] font-medium leading-tight text-zinc-800 dark:text-zinc-200">
        {commit.subject}
      </span>
    </div>
  );
}

function CommitBatchHoverCard({
  group,
  label,
  commits,
  onCommitSelectBase,
}: {
  group: ProjectedCommitGroup;
  label: string;
  commits: ProjectedCommitEntity[];
  onCommitSelectBase?: (commit: ProjectedCommitEntity) => void;
}) {
  return (
    <div className="nodrag nowheel w-[420px] overflow-hidden rounded-[14px] border border-zinc-200/90 bg-zinc-50/98 text-zinc-950 shadow-[0_24px_70px_-28px_rgba(15,23,42,0.5),0_4px_14px_-8px_rgba(15,23,42,0.22)] backdrop-blur-xl dark:border-zinc-800/90 dark:bg-zinc-950/98 dark:text-zinc-100 dark:shadow-[0_24px_70px_-30px_rgba(0,0,0,0.85)]">
      <div className="border-b border-zinc-200/80 bg-white/72 px-4 py-3 dark:border-zinc-800/80 dark:bg-white/[0.04]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300">
              <Layers3 size={13} />
              {label} batch
            </div>
            <div className="mt-1 font-mono text-[12px] font-semibold text-zinc-800 dark:text-zinc-200">
              {group.firstSha.slice(0, 8)}..{group.lastSha.slice(0, 8)}
            </div>
          </div>
          <div className="rounded-[8px] bg-emerald-50 px-2.5 py-1.5 text-right ring-1 ring-emerald-200/80 dark:bg-emerald-950/60 dark:ring-emerald-800/70">
            <div className="text-[15px] font-semibold leading-none text-emerald-800 dark:text-emerald-200">{group.commitShas.length}</div>
            <div className="mt-0.5 text-[9px] font-medium uppercase tracking-[0.1em] text-emerald-700/75 dark:text-emerald-300/75">commits</div>
          </div>
        </div>
      </div>

      <div
        className="custom-scrollbar max-h-[360px] space-y-2 overflow-y-auto overscroll-contain p-3"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        {commits.map((commit) => (
          <RichCommitRow key={commit.sha} commit={commit} onSelectBase={onCommitSelectBase} />
        ))}
      </div>
    </div>
  );
}

export const GraphDerivedCommitGroupNode = memo(({
  group,
  projection,
  isFocused = false,
  isSelected = false,
  isComposerBaseCommit = false,
  onCommitSelectBase,
}: GraphDerivedCommitGroupNodeProps) => {
  const commits = group.commitShas
    .map((sha) => projection?.commitBySha.get(sha))
    .filter(Boolean);
  const first = projection?.commitBySha.get(group.firstSha);
  const last = projection?.commitBySha.get(group.lastSha);
  const label = sourceLabelByKind[group.sourceKind];
  const visibleCommits = (commits.length > 0 ? commits : [first, last]).filter(isProjectedCommit);
  const hoverCardCommits = [...visibleCommits].sort((left, right) => (
    right.sortTs - left.sortTs || right.sha.localeCompare(left.sha)
  ));
  const previewCommits = visibleCommits.slice(-2);
  const hiddenPreviewCount = Math.max(0, group.commitShas.length - previewCommits.length);
  const batchNode = (
    <div
      className={cn(
        'relative h-full w-[120px] overflow-hidden rounded-l-[2px] rounded-r-[9px] border border-emerald-300/70 bg-[radial-gradient(circle_at_85%_10%,rgba(255,255,255,0.82),transparent_42%),linear-gradient(180deg,rgba(236,253,245,0.98),rgba(209,250,229,0.92))] px-2 py-2 text-emerald-950 shadow-[0_12px_28px_-22px_rgba(4,120,87,0.72),0_1px_0_rgba(255,255,255,0.78)_inset] transition-all duration-200 hover:-translate-y-px hover:border-emerald-400/80 hover:shadow-[0_18px_34px_-24px_rgba(4,120,87,0.82),0_1px_0_rgba(255,255,255,0.82)_inset] dark:border-emerald-800/75 dark:bg-[radial-gradient(circle_at_85%_10%,rgba(52,211,153,0.16),transparent_42%),linear-gradient(180deg,rgba(6,78,59,0.5),rgba(2,44,34,0.36))] dark:text-emerald-100 dark:shadow-[0_14px_32px_-26px_rgba(0,0,0,0.9)]',
        isFocused && 'ring-2 ring-indigo-400/70',
        isComposerBaseCommit && !isFocused && 'border-emerald-600 ring-2 ring-emerald-600/80 shadow-[0_0_0_1.5px_rgba(5,150,105,0.72),0_18px_34px_-24px_rgba(4,120,87,0.92)] dark:border-emerald-400',
        isSelected && !isComposerBaseCommit && 'ring-2 ring-emerald-400/80',
      )}
      title={`${group.commitShas.length} ${label.toLowerCase()} commits: ${group.firstSha.slice(0, 8)}..${group.lastSha.slice(0, 8)}`}
    >
      <div className="absolute left-[-2px] top-0 h-full w-[3px] rounded-l-[2px] bg-emerald-500/75 dark:bg-emerald-500/60" />
      <div className="pointer-events-none absolute inset-y-2 left-[7px] w-px bg-emerald-300/70 dark:bg-emerald-800/80" />
      <div className="pointer-events-none absolute inset-x-2 bottom-[-5px] h-5 rounded-[8px] border border-emerald-200/80 bg-emerald-100/70 dark:border-emerald-900/80 dark:bg-emerald-950/70" />
      <div className="pointer-events-none absolute inset-x-3 bottom-[-10px] h-5 rounded-[8px] border border-emerald-200/60 bg-emerald-100/45 dark:border-emerald-900/60 dark:bg-emerald-950/45" />

      <div className="relative flex h-full min-h-0 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-1">
          <Layers3 size={12} className="text-emerald-700 dark:text-emerald-300" />
          <span className="truncate text-[8px] font-semibold uppercase tracking-[0.08em] text-emerald-800 dark:text-emerald-300">
            {label}
          </span>
        </div>

        <div className="rounded-[6px] border border-emerald-200/75 bg-white/75 px-1.5 py-1 text-center font-mono text-[9px] leading-none text-emerald-900 shadow-[0_1px_0_rgba(255,255,255,0.86)_inset] dark:border-emerald-800/70 dark:bg-emerald-950/60 dark:text-emerald-200 dark:shadow-none">
          {group.firstSha.slice(0, 6)}..{group.lastSha.slice(0, 6)}
        </div>

        <div className="flex min-h-0 flex-1 flex-col justify-center gap-1 overflow-hidden">
          {hiddenPreviewCount > 0 ? (
            <div className="flex items-center gap-1 rounded-[5px] border border-emerald-200/55 bg-emerald-100/70 px-1.5 py-1 text-[8px] font-semibold leading-none text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/55 dark:text-emerald-300">
              <Rows3 size={8} />
              {hiddenPreviewCount} earlier
            </div>
          ) : null}
          {previewCommits.map((commit) => (
            <CompactCommitPreviewRow key={commit!.sha} commit={commit!} />
          ))}
        </div>

        <div className="flex items-center justify-between gap-1 border-t border-emerald-300/50 pt-1 text-[8px] font-semibold leading-none text-emerald-700 dark:border-emerald-800/80 dark:text-emerald-300">
          <span>{group.commitShas.length} commits</span>
          <span className="font-medium text-emerald-700/70 dark:text-emerald-300/70">hover</span>
        </div>
      </div>

      <Handle
        id="top-target"
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-slate-400"
      />
      <Handle
        id="left-target"
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-0 !bg-transparent"
      />
      <Handle
        id="right-target"
        type="target"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-0 !bg-transparent"
      />
      <Handle
        id="bottom-source"
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !border-2 !border-background !bg-slate-400"
      />
    </div>
  );

  return (
    <HoverCard openDelay={160} closeDelay={140}>
      <HoverCardTrigger asChild>
        {batchNode}
      </HoverCardTrigger>
      <HoverCardContent side="right" align="center" sideOffset={10} className="z-[210] w-auto border-none bg-transparent p-0 shadow-none">
        <CommitBatchHoverCard group={group} label={label} commits={hoverCardCommits} onCommitSelectBase={onCommitSelectBase} />
      </HoverCardContent>
    </HoverCard>
  );
});

GraphDerivedCommitGroupNode.displayName = 'GraphDerivedCommitGroupNode';
