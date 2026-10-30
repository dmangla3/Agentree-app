import { CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../@/components/ui/alert-dialog';
import { Checkbox } from '../../@/components/ui/checkbox';
import { formatDeleteBranchPreview, type DeleteBranchPreview } from '../domain/deleteBranchPreview';
import { cn } from '../lib/utils';

export type DeleteBranchDialogPhase = 'idle' | 'deleting' | 'success';

interface DeleteBranchDialogProps {
  open: boolean;
  title: string;
  preview: DeleteBranchPreview;
  phase: DeleteBranchDialogPhase;
  removableCommitCount?: number;
  removeCommitsFromGraph?: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRemoveCommitsFromGraphChange?: (checked: boolean) => void;
}

const pluralize = (count: number, singular: string, plural = `${singular}s`) => (
  `${count} ${count === 1 ? singular : plural}`
);

const detailSections = [
  ['User nodes', 'user'],
  ['Assistant nodes', 'assistant'],
  ['Commit nodes', 'commit'],
  ['Other nodes', 'other'],
] as const;

export function DeleteBranchDialog({
  open,
  title,
  preview,
  phase,
  removableCommitCount = 0,
  removeCommitsFromGraph = false,
  onOpenChange,
  onCancel,
  onConfirm,
  onRemoveCommitsFromGraphChange,
}: DeleteBranchDialogProps) {
  const isDeleting = phase === 'deleting';
  const isSuccess = phase === 'success';
  const progressLabel = isSuccess
    ? `Deleted ${pluralize(preview.totalCount, 'node')}`
    : isDeleting
      ? 'Deleting selected branches'
      : `${pluralize(preview.totalCount, 'node')} affected`;
  const hasDetails = Boolean(preview.threadLabel)
    || preview.rootLabels.length > 0
    || detailSections.some(([, key]) => preview.groups[key].length > 0);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-design-scope="panels" className="overflow-hidden bg-[hsl(var(--app-panel-strong))] sm:max-w-[520px]">
        <AlertDialogHeader>
          <div className="mb-1 flex items-center gap-3">
            <div
              className={cn(
                'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 ease-out',
                isSuccess
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                  : 'bg-destructive/10 text-destructive'
              )}
            >
              <CheckCircle2
                className={cn(
                  'absolute h-5 w-5 transition-[opacity,scale,filter] duration-200 ease-out',
                  isSuccess ? 'scale-100 opacity-100 blur-0' : 'scale-[0.25] opacity-0 blur-sm'
                )}
              />
              <Trash2
                className={cn(
                  'h-5 w-5 transition-[opacity,scale,filter] duration-200 ease-out',
                  isSuccess ? 'scale-[0.25] opacity-0 blur-sm' : 'scale-100 opacity-100 blur-0'
                )}
              />
            </div>
            <div className="min-w-0">
              <AlertDialogTitle className="text-balance">
                {isSuccess ? 'Deleted nodes' : title}
              </AlertDialogTitle>
              <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                {progressLabel}
              </div>
            </div>
          </div>
          <AlertDialogDescription className="text-pretty">
            {isSuccess
              ? `${preview.typeSummary} removed from this workspace.`
              : formatDeleteBranchPreview(preview)}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div
          className={cn(
            'rounded-xl bg-muted/35 p-3 shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.58)] transition-[background-color,box-shadow] duration-200 ease-out',
            isSuccess && 'border-emerald-500/25 bg-emerald-500/10'
          )}
        >
          <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{isSuccess ? 'Complete' : isDeleting ? 'Deleting branches' : 'Ready to delete'}</span>
            <span className="tabular-nums">{isSuccess ? '100%' : isDeleting ? 'In progress' : '0%'}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-background shadow-inner">
            <div
              className={cn(
                'h-full rounded-full transition-[width,background-color] duration-300 ease-out',
                isSuccess
                  ? 'bg-emerald-500'
                  : isDeleting
                    ? 'w-1/2 animate-[pulse_1.1s_ease-out_infinite] bg-destructive'
                    : 'bg-destructive'
              )}
              style={{ width: isSuccess ? '100%' : isDeleting ? undefined : '0%' }}
            />
          </div>
          {isDeleting ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground animate-in fade-in duration-200">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Deleting selected branches and descendants...</span>
            </div>
          ) : null}
        </div>

        {hasDetails && !isSuccess ? (
          <div className="max-h-64 overflow-y-auto rounded-xl bg-background/70 p-3 text-sm shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.58)]">
            {preview.threadLabel ? (
              <div className="mb-3 min-w-0">
                <div className="text-xs font-medium text-muted-foreground">Thread</div>
                <div className="mt-1 truncate font-medium text-foreground" title={preview.threadLabel}>
                  {preview.threadLabel}
                </div>
              </div>
            ) : null}

            {preview.rootLabels.length > 0 ? (
              <div className="mb-3 min-w-0">
                <div className="text-xs font-medium text-muted-foreground">Selected branches</div>
                <ul className="mt-1 space-y-1">
                  {preview.rootLabels.map((item) => (
                    <li key={item.id} className="truncate text-foreground" title={item.label}>
                      {item.label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid gap-3">
              {detailSections.map(([label, key]) => {
                const items = preview.groups[key];
                if (items.length === 0) return null;
                return (
                  <div key={key} className="min-w-0">
                    <div className="text-xs font-medium text-muted-foreground">
                      {label}
                    </div>
                    <ul className="mt-1 space-y-1">
                      {items.map((item) => (
                        <li key={item.id} className="truncate text-foreground" title={item.label}>
                          {item.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {removableCommitCount > 0 && !isSuccess ? (
          <label className={cn(
            'flex min-h-10 items-start gap-3 rounded-lg bg-background/70 p-3 text-sm shadow-[inset_0_0_0_1px_hsl(var(--app-border)/0.58)] transition-[background-color,opacity] duration-150 ease-out',
            (isDeleting || isSuccess) && 'opacity-70'
          )}>
            <Checkbox
              checked={removeCommitsFromGraph}
              disabled={isDeleting || isSuccess}
              onCheckedChange={(checked) => onRemoveCommitsFromGraphChange?.(checked === true)}
              className="mt-0.5"
            />
            <span className="grid gap-0.5 leading-none">
              <span className="font-medium text-foreground">Remove commits from graph</span>
              <span className="text-xs leading-5 text-muted-foreground">
                Also hide {pluralize(removableCommitCount, 'commit node')} connected to this deletion.
              </span>
            </span>
          </label>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel className="h-10 rounded-lg" disabled={isDeleting || isSuccess} onClick={onCancel}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={isDeleting || isSuccess}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            className="h-10 min-w-32 rounded-lg bg-destructive text-destructive-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-destructive/90 active:scale-[0.96]"
          >
            {isDeleting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Deleting
              </span>
            ) : (
              'Confirm Delete'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
