import { GitCommitVertical } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { ProjectedNodeEntity } from '../../../domain/workspaceProjection';
import { getMessageOutputCommitSha } from '../../../lib/graph/commitAccessors';
import { CopyCommitShaButton } from '../../CopyCommitShaButton';

interface VerticalSideCommitNodeProps {
  entity: ProjectedNodeEntity;
  className?: string;
}

export function VerticalSideCommitNode({ entity, className }: VerticalSideCommitNodeProps) {
  const commitSha = getMessageOutputCommitSha(entity.message);
  const shortSha = entity.shortSha ?? commitSha?.slice(0, 8) ?? 'commit';

  return (
    <div
      className={cn(
        'flex min-h-20 w-12 flex-col items-center justify-center gap-1 rounded-xl border border-emerald-200/70 bg-emerald-50/80 px-1 py-2 text-emerald-700 shadow-sm dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-300',
        className,
      )}
      title={commitSha ?? entity.preview}
    >
      <GitCommitVertical size={14} />
      <span className="max-h-14 rotate-180 overflow-hidden text-ellipsis [writing-mode:vertical-rl] font-mono text-[10px] leading-none">
        {shortSha}
      </span>
      <CopyCommitShaButton commitSha={commitSha} className="h-3.5 w-3.5" />
    </div>
  );
}
