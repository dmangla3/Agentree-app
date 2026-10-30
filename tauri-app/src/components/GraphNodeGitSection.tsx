import { ReactNode } from 'react';
import type { BranchPointer } from '../stores/workspaceStore';
import { cn } from '../lib/utils';
import { GitNodeMeta } from './GitNodeMeta';

interface GraphNodeGitSectionProps {
  commitSha?: string | null;
  branchPointers?: BranchPointer[] | null;
  action?: ReactNode;
  className?: string;
}

export function GraphNodeGitSection({
  commitSha = null,
  branchPointers = [],
  action = null,
  className,
}: GraphNodeGitSectionProps) {
  const hasMeta = Boolean(commitSha) || (branchPointers?.length ?? 0) > 0;
  if (!hasMeta && !action) return null;

  return (
    <div className={cn('flex items-start justify-between gap-2 border-t border-[hsl(var(--app-border)/0.52)] pt-2', className)}>
      <GitNodeMeta
        commitSha={commitSha}
        branchPointers={branchPointers}
        className="min-w-0 flex-1"
      />
      {action ? <div className="flex shrink-0 items-center gap-1 nodrag">{action}</div> : null}
    </div>
  );
}
