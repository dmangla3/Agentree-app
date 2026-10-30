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
    <div data-design-scope="panels" className="fixed inset-0 z-50 flex items-center justify-center antialiased">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={isApplying ? undefined : handleClose}
      />

      <div className="relative mx-4 w-full max-w-md overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel))] shadow-[0_24px_64px_-32px_hsl(var(--foreground)/0.58)]">
        <div className="flex min-h-14 items-center justify-between border-b border-[hsl(var(--app-border)/0.58)] px-5 py-3">
          <div className="text-balance text-base font-semibold text-foreground">
            {isApplying ? 'Applying Merge...' : isSuccess ? 'Merge Complete' : 'Merge Result'}
          </div>
          {!isApplying && (
            <button
              type="button"
              aria-label="Close merge result"
              onClick={handleClose}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:bg-[hsl(var(--app-bg-muted))] hover:text-foreground active:scale-[0.96] motion-reduce:transition-none"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="p-4">
          {isApplying && (
            <div className="flex flex-col items-center py-6">
              <Loader2 className="mb-3 h-7 w-7 animate-spin text-muted-foreground motion-reduce:animate-none" />
              <p className="text-foreground">Creating merge commit...</p>
            </div>
          )}

          {!isApplying && isSuccess && applyResult && (
            <div className="flex flex-col items-center py-4">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(var(--app-success)/0.1)]">
                <CheckCircle className="h-6 w-6 text-[hsl(var(--app-success))]" />
              </div>
              <div className="text-base font-medium text-foreground">Merge successful</div>
              <div className="mt-2 text-center text-sm text-muted-foreground">
                Commit <span className="font-mono tabular-nums text-foreground">{applyResult.commit_sha?.slice(0, 12)}</span> was created.
              </div>
            </div>
          )}

          {!isApplying && hasConflicts && applyResult && (
            <div className="flex flex-col items-center py-4">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(var(--app-warning)/0.1)]">
                <AlertCircle className="h-6 w-6 text-[hsl(var(--app-warning))]" />
              </div>
              <div className="text-base font-medium text-foreground">Conflicts need resolution</div>
              <div className="mt-2 text-center text-sm text-muted-foreground">
                Git left the merge in a temporary worktree because unresolved conflicts remain.
              </div>
            </div>
          )}

          {!isApplying && applyError && (
            <div className="flex flex-col items-center py-4">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
                <AlertCircle className="h-6 w-6 text-destructive" />
              </div>
              <div className="text-base font-medium text-foreground">Merge failed</div>
              <div className="mt-2 text-center text-sm text-destructive">
                {applyError}
              </div>
            </div>
          )}
        </div>

        {!isApplying && (
          <div className="flex items-center justify-end gap-2 border-t border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.36)] px-4 py-3">
            {isSuccess && applyResult?.resultNodeId && (
              <button
                onClick={handleViewResult}
                className="flex h-10 items-center gap-2 rounded-lg bg-[hsl(var(--app-accent))] px-4 text-sm font-medium text-white shadow-[0_10px_24px_-18px_hsl(var(--app-accent)/0.72)] transition-[filter,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:brightness-105 active:scale-[0.96] motion-reduce:transition-none"
              >
                <ArrowRight className="h-4 w-4" />
                View Merge Node
              </button>
            )}
            <button
              onClick={handleClose}
              className="h-10 rounded-lg border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong))] px-4 text-sm font-medium text-foreground transition-[background-color,transform] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:bg-[hsl(var(--app-bg-muted))] active:scale-[0.96] motion-reduce:transition-none"
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
