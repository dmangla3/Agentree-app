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

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="overflow-hidden sm:max-w-[460px]">
        <AlertDialogHeader>
          <div className="mb-1 flex items-center gap-3">
            <div
              className={cn(
                'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors duration-200',
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
            'rounded-lg border bg-muted/35 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-[border-color,background-color] duration-200',
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
                    ? 'w-1/2 animate-[pulse_1.1s_ease-in-out_infinite] bg-destructive'
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

        {removableCommitCount > 0 && !isSuccess ? (
          <label className={cn(
            'flex items-start gap-3 rounded-md border bg-background/70 p-3 text-sm transition-colors',
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
          <AlertDialogCancel disabled={isDeleting || isSuccess} onClick={onCancel}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={isDeleting || isSuccess}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            className="min-w-32 bg-destructive text-destructive-foreground transition-[background-color,scale] duration-150 hover:bg-destructive/90 active:scale-[0.96]"
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
