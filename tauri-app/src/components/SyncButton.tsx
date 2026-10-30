import { MouseEvent } from 'react';
import { GitMerge, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useMergeStore } from '../stores/mergeStore';

interface SyncButtonProps {
  nodeId: string;
  repoPath: string;
  branchName: string;
  label?: string;
  hasFileChanges?: boolean;
  className?: string;
}

export function SyncButton({
  nodeId,
  repoPath,
  branchName,
  label,
  hasFileChanges,
  className = '',
}: SyncButtonProps) {
  const { enterSelectionMode, selectionMode } = useMergeStore();

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    enterSelectionMode(nodeId, repoPath, branchName, label ?? nodeId.slice(0, 8));
  };

  return (
    <button
      data-agentree-merge-source-button="true"
      disabled={selectionMode}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg transition-[background-color,color,transform,box-shadow] duration-150 ease-out hover:bg-background hover:shadow-sm active:scale-[0.96] motion-reduce:transition-none',
        hasFileChanges
          ? 'text-emerald-500 hover:text-emerald-400'
          : 'text-muted-foreground hover:text-foreground',
        selectionMode && 'opacity-50 cursor-not-allowed',
        className
      )}
      title="Select this node as a merge source"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={handleClick}
    >
      <GitMerge size={12} />
    </button>
  );
}

export function MergeSelectionOverlay() {
  const { selectionMode, sourceNodeId, sourceLabel, exitSelectionMode } = useMergeStore();

  if (!selectionMode) return null;

  return (
    <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-xl border border-primary/25 bg-popover/95 px-4 py-3 shadow-[0_0_0_1px_hsl(var(--foreground)/0.025),0_14px_38px_-18px_hsl(var(--foreground)/0.42)] backdrop-blur-md">
        <GitMerge className="h-5 w-5 text-primary" />
        <div>
          <div className="text-sm font-semibold text-foreground">Select merge target</div>
          <div className="mt-0.5 text-pretty text-xs text-muted-foreground">
            Click another node to merge from {sourceLabel ?? sourceNodeId?.slice(0, 8)}.
          </div>
        </div>
        <button
          onClick={exitSelectionMode}
          className="ml-1 flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.96] motion-reduce:transition-none"
          title="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default SyncButton;
