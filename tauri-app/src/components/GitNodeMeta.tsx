import { GitBranch, GitCommitHorizontal } from 'lucide-react';
import { cn } from '../lib/utils';
import type { BranchPointer } from '../stores/workspaceStore';
import { CopyCommitShaButton } from './CopyCommitShaButton';

interface GitNodeMetaProps {
  commitSha?: string | null;
  branchPointers?: BranchPointer[] | null;
  className?: string;
}

export function GitNodeMeta({
  commitSha = null,
  branchPointers = [],
  className,
}: GitNodeMetaProps) {
  const shortCommitId = commitSha ? commitSha.slice(0, 8) : null;
  const refs = branchPointers ?? [];
  const hasBranchRef = refs.length > 0;
  const hasShipPathRef = refs.some((pointer) => pointer.is_ship_path);

  if (!shortCommitId && !hasBranchRef) return null;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {shortCommitId && (
        <span
          className="flex items-center gap-1.5 px-2 py-1 rounded-full border border-border/40 bg-background/80 backdrop-blur-xl text-[10px] font-mono font-medium leading-none text-muted-foreground shadow-[0_1px_3px_rgba(0,0,0,0.04)] ring-1 ring-white/10 dark:ring-white/5 transition-colors hover:bg-background/90"
          title={commitSha ?? undefined}
        >
          <GitCommitHorizontal size={10} className="shrink-0 opacity-70" />
          <span>{shortCommitId}</span>
          <CopyCommitShaButton commitSha={commitSha} className="ml-0.5" />
        </span>
      )}
      {hasBranchRef && (
        <span
          className={cn(
            'flex items-center gap-1.5 max-w-[126px] px-2 py-1 rounded-full border text-[10px] font-mono font-medium leading-none shadow-[0_1px_3px_rgba(0,0,0,0.04)] ring-1 ring-white/10 dark:ring-white/5 transition-colors',
            hasShipPathRef
              ? 'border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : 'border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/15 text-sky-700 dark:text-sky-300'
          )}
          title={refs.map((pointer) => pointer.name).join(', ')}
        >
          <GitBranch size={10} className="shrink-0 opacity-80" />
          <span className="truncate">
            {refs[0]?.name ?? 'ref'}
          </span>
          {refs.length > 1 && (
            <span className="opacity-70">
              +{refs.length - 1}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
