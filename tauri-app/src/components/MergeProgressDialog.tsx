import { AlertCircle, ArrowRight, CheckCircle, Loader2, X } from 'lucide-react';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useMergeStore } from '../stores/mergeStore';

export function MergeProgressDialog() {
  const {
    progressDialogOpen,
    isApplying,
    applyResult,
    applyError,
    reset,
  } = useMergeStore();
  const dispatchFocus = useWorkspaceStore((state) => state.dispatchFocus);

  if (!progressDialogOpen) {
    return null;
  }

  const handleClose = () => {
    reset();
  };

  const handleViewResult = () => {
    if (applyResult?.resultNodeId) {
      dispatchFocus({ messageId: applyResult.resultNodeId, source: 'system', metadata: { reason: 'merge-result' } });
    }
    reset();
  };

  const hasConflicts = applyResult?.status === 'conflicts';
  const isSuccess = !!applyResult?.commit_sha && !hasConflicts;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={isApplying ? undefined : handleClose}
      />

      <div className="relative mx-4 w-full max-w-md overflow-hidden rounded-xl border border-zinc-700/50 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-700/50 px-6 py-4">
          <div className="text-lg font-semibold text-white">
            {isApplying ? 'Applying Merge...' : isSuccess ? 'Merge Complete' : 'Merge Result'}
          </div>
          {!isApplying && (
            <button
              onClick={handleClose}
              className="rounded-lg p-1.5 transition-colors hover:bg-zinc-700/50"
            >
              <X className="h-5 w-5 text-zinc-400" />
            </button>
          )}
        </div>

        <div className="p-6">
          {isApplying && (
            <div className="flex flex-col items-center py-8">
              <Loader2 className="mb-4 h-12 w-12 animate-spin text-blue-400" />
              <p className="text-zinc-300">Creating merge commit...</p>
            </div>
          )}

          {!isApplying && isSuccess && applyResult && (
            <div className="flex flex-col items-center py-4">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
                <CheckCircle className="h-10 w-10 text-emerald-400" />
              </div>
              <div className="text-lg font-medium text-white">Merge Successful</div>
              <div className="mt-2 text-center text-sm text-zinc-400">
                Commit <span className="font-mono text-zinc-200">{applyResult.commit_sha?.slice(0, 12)}</span> was created.
              </div>
            </div>
          )}

          {!isApplying && hasConflicts && applyResult && (
            <div className="flex flex-col items-center py-4">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10">
                <AlertCircle className="h-10 w-10 text-amber-400" />
              </div>
              <div className="text-lg font-medium text-white">Conflicts Need Resolution</div>
              <div className="mt-2 text-center text-sm text-zinc-400">
                Git left the merge in a temporary worktree because unresolved conflicts remain.
              </div>
            </div>
          )}

          {!isApplying && applyError && (
            <div className="flex flex-col items-center py-4">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
                <AlertCircle className="h-10 w-10 text-red-400" />
              </div>
              <div className="text-lg font-medium text-white">Merge Failed</div>
              <div className="mt-2 text-center text-sm text-red-300">
                {applyError}
              </div>
            </div>
          )}
        </div>

        {!isApplying && (
          <div className="flex items-center justify-end gap-2 border-t border-zinc-700/50 bg-zinc-800/50 px-6 py-4">
            {isSuccess && applyResult?.resultNodeId && (
              <button
                onClick={handleViewResult}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
              >
                <ArrowRight className="h-4 w-4" />
                View Merge Node
              </button>
            )}
            <button
              onClick={handleClose}
              className="rounded-lg bg-zinc-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-600"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default MergeProgressDialog;
