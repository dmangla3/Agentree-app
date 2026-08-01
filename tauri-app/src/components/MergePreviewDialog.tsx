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
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : 'border-amber-500/30 bg-amber-500/10 text-amber-300';

  return (
    <div className={`rounded-lg border p-4 ${toneClasses}`}>
      <div className="mb-2 text-sm font-medium">{title}</div>
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {files.map((file) => (
          <div key={file} className="font-mono text-xs">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => !applyMerge.isPending && setPreviewDialogOpen(false)}
      />

      <div className="relative mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-700/50 bg-zinc-900 shadow-2xl">
        <div className="border-b border-zinc-700/50 px-6 py-4">
          <div className="text-lg font-semibold text-white">Git Merge Preview</div>
          <div className="mt-1 flex items-center gap-2 text-sm text-zinc-400">
            <GitBranch className="h-4 w-4" />
            <span>{sourceLabel}</span>
            <ArrowRight className="h-3 w-3" />
            <span>{targetLabel}</span>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          {totalFiles === 0 && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300">
              This branch is already up to date with the selected target.
            </div>
          )}

          <div className="flex flex-wrap gap-4 text-sm">
            <div className="flex items-center gap-2 text-zinc-300">
              <Check className="h-4 w-4 text-emerald-400" />
              <span>{preview.auto_mergeable_files.length} auto-mergeable</span>
            </div>
            <div className="flex items-center gap-2 text-zinc-300">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              <span>{preview.conflicted_files.length} conflicts</span>
            </div>
          </div>

          {preview.has_conflicts && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300">
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

        <div className="flex items-center justify-between gap-3 border-t border-zinc-700/50 bg-zinc-800/50 px-6 py-4">
          <button
            onClick={() => setPreviewDialogOpen(false)}
            disabled={applyMerge.isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-700/50 hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2">
            {preview.has_conflicts && (
              <>
                <button
                  onClick={() => applyMerge.mutate({ conflictStrategy: 'target' })}
                  disabled={applyMerge.isPending}
                  className="rounded-lg bg-zinc-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-600 disabled:opacity-50"
                >
                  {applyMerge.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Keep Target on Conflicts'}
                </button>
                <button
                  onClick={() => applyMerge.mutate({ conflictStrategy: 'source' })}
                  disabled={applyMerge.isPending}
                  className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
                >
                  {applyMerge.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Take Source on Conflicts'}
                </button>
              </>
            )}

            <button
              onClick={() => applyMerge.mutate({})}
              disabled={applyMerge.isPending || !canApplyCleanly}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
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
