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
          className="flex items-center gap-1.5 rounded-md border border-[hsl(var(--app-border)/0.5)] bg-[hsl(var(--app-panel-strong)/0.62)] px-2 py-1 font-mono text-[10px] font-medium leading-none text-muted-foreground transition-colors hover:bg-[hsl(var(--app-panel-strong)/0.82)]"
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
            'flex max-w-[126px] items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px] font-medium leading-none transition-colors',
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
