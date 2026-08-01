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
        'p-1 rounded hover:bg-background hover:shadow-sm transition-all',
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
    <div className="fixed top-4 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-lg border border-blue-500/40 bg-blue-950/85 px-4 py-2.5 shadow-lg backdrop-blur-sm">
        <GitMerge className="h-5 w-5 text-blue-300" />
        <div>
          <div className="text-sm font-medium text-white">Select Merge Target</div>
          <div className="text-xs text-blue-200/80">
            Click another node to merge from {sourceLabel ?? sourceNodeId?.slice(0, 8)}.
          </div>
        </div>
        <button
          onClick={exitSelectionMode}
          className="ml-2 rounded p-1 transition-colors hover:bg-blue-900/60"
          title="Cancel"
        >
          <X className="h-4 w-4 text-blue-200" />
        </button>
      </div>
    </div>
  );
}

export default SyncButton;
