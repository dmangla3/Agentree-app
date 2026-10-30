import { AlertTriangle, ArrowRight, Check, GitBranch, Loader2 } from 'lucide-react';
import { useApplyGitMerge } from '../hooks/useMerge';
import { useMergeStore } from '../stores/mergeStore';

function FileList({
  title,
  files,
  tone,
}: {
  title: string;
  files: string[];
  tone: 'emerald' | 'amber';
}) {
  if (files.length === 0) return null;

  const toneClasses = tone === 'emerald'
    ? 'border-[hsl(var(--app-success)/0.28)] bg-[hsl(var(--app-success)/0.08)] text-[hsl(var(--app-success))]'
    : 'border-[hsl(var(--app-warning)/0.28)] bg-[hsl(var(--app-warning)/0.08)] text-[hsl(var(--app-warning))]';

  return (
    <div className={`rounded-lg border p-3 ${toneClasses}`}>
      <div className="mb-2 text-sm font-medium">{title}</div>
      <div className="max-h-48 divide-y divide-current/10 overflow-y-auto">
        {files.map((file) => (
          <div key={file} className="py-1 font-mono text-xs first:pt-0 last:pb-0">
            {file}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MergePreviewDialog() {
  const { previewDialogOpen, previewSession, setPreviewDialogOpen } = useMergeStore();
  const applyMerge = useApplyGitMerge();

  if (!previewDialogOpen || !previewSession) {
    return null;
  }

  const { preview, sourceLabel, targetLabel } = previewSession;
  const totalFiles = preview.auto_mergeable_files.length + preview.conflicted_files.length;
  const canApplyCleanly = !preview.has_conflicts;

  return (
    <div data-design-scope="panels" className="fixed inset-0 z-50 flex items-center justify-center antialiased">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => !applyMerge.isPending && setPreviewDialogOpen(false)}
      />

      <div className="relative mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel))] shadow-[0_24px_64px_-32px_hsl(var(--foreground)/0.58)]">
        <div className="border-b border-[hsl(var(--app-border)/0.58)] px-4 py-3">
          <div className="text-balance text-base font-semibold text-foreground">Git merge preview</div>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <GitBranch className="h-4 w-4" />
            <span>{sourceLabel}</span>
            <ArrowRight className="h-3 w-3" />
            <span>{targetLabel}</span>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {totalFiles === 0 && (
            <div className="rounded-lg border border-[hsl(var(--app-success)/0.28)] bg-[hsl(var(--app-success)/0.08)] p-3 text-sm text-[hsl(var(--app-success))]">
              This branch is already up to date with the selected target.
            </div>
          )}

          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2 text-foreground">
              <Check className="h-4 w-4 text-[hsl(var(--app-success))]" />
              <span>{preview.auto_mergeable_files.length} auto-mergeable</span>
            </div>
            <div className="flex items-center gap-2 text-foreground">
              <AlertTriangle className="h-4 w-4 text-[hsl(var(--app-warning))]" />
              <span>{preview.conflicted_files.length} conflicts</span>
            </div>
          </div>

          {preview.has_conflicts && (
            <div className="rounded-lg border border-[hsl(var(--app-warning)/0.28)] bg-[hsl(var(--app-warning)/0.08)] p-3 text-sm text-[hsl(var(--app-warning))]">
              Conflicts were detected. You can still apply the merge by choosing how conflicted files should resolve.
            </div>
          )}

          <FileList
            title="Auto-mergeable Files"
            files={preview.auto_mergeable_files}
            tone="emerald"
          />

          <FileList
            title="Conflicted Files"
            files={preview.conflicted_files}
            tone="amber"
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[hsl(var(--app-border)/0.58)] bg-[hsl(var(--app-bg-muted)/0.36)] px-4 py-3">
          <button
            onClick={() => setPreviewDialogOpen(false)}
            disabled={applyMerge.isPending}
            className="h-10 rounded-lg px-4 text-sm font-medium text-muted-foreground transition-[background-color,color,transform,opacity] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:bg-[hsl(var(--app-panel-strong))] hover:text-foreground active:scale-[0.96] motion-reduce:transition-none disabled:opacity-50"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2">
            {preview.has_conflicts && (
              <>
                <button
                  onClick={() => applyMerge.mutate({ conflictStrategy: 'target' })}
                  disabled={applyMerge.isPending}
                  className="h-10 rounded-lg border border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel-strong))] px-4 text-sm font-medium text-foreground transition-[background-color,transform,opacity] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:bg-[hsl(var(--app-bg-muted))] active:scale-[0.96] motion-reduce:transition-none disabled:opacity-50"
                >
                  {applyMerge.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Keep Target on Conflicts'}
                </button>
                <button
                  onClick={() => applyMerge.mutate({ conflictStrategy: 'source' })}
                  disabled={applyMerge.isPending}
                  className="h-10 rounded-lg bg-[hsl(var(--app-warning))] px-4 text-sm font-medium text-white transition-[filter,transform,opacity] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:brightness-105 active:scale-[0.96] motion-reduce:transition-none disabled:opacity-50"
                >
                  {applyMerge.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Take Source on Conflicts'}
                </button>
              </>
            )}

            <button
              onClick={() => applyMerge.mutate({})}
              disabled={applyMerge.isPending || !canApplyCleanly}
              className="h-10 rounded-lg bg-[hsl(var(--app-accent))] px-4 text-sm font-medium text-white shadow-[0_10px_24px_-18px_hsl(var(--app-accent)/0.72)] transition-[filter,transform,opacity] duration-150 [transition-timing-function:cubic-bezier(0.2,0,0,1)] hover:brightness-105 active:scale-[0.96] motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {applyMerge.isPending ? 'Applying...' : 'Apply Clean Merge'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MergePreviewDialog;
