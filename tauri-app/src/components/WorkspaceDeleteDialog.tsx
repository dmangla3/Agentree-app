import { Loader2, Trash2 } from 'lucide-react';
import type { Workspace } from '../stores/workspaceStore';
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

interface WorkspaceDeleteDialogProps {
  workspace: Workspace | null;
  isDeleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function WorkspaceDeleteDialog({
  workspace,
  isDeleting,
  onOpenChange,
  onConfirm,
}: WorkspaceDeleteDialogProps) {
  return (
    <AlertDialog open={workspace !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent data-design-scope="panels" className="gap-0 overflow-hidden rounded-xl border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel))] p-0 shadow-[0_24px_64px_-32px_hsl(var(--foreground)/0.5)] dark:border-white/10 dark:bg-[hsl(var(--app-panel))] sm:max-w-[420px]">
        <AlertDialogHeader className="border-b border-[hsl(var(--app-border)/0.68)] px-5 py-4 text-left dark:border-white/10">
          <div className="flex items-center gap-2.5">
            <Trash2 className="h-4 w-4 shrink-0 text-destructive" />
            <AlertDialogTitle>Delete workspace?</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="pt-1">
            {workspace
              ? `"${workspace.name}" and its conversation history will be removed.`
              : 'This workspace and its conversation history will be removed.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="px-5 py-3">
          <AlertDialogCancel className="h-10 rounded-lg active:scale-[0.96]" disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isDeleting}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            className="h-10 rounded-lg bg-destructive text-destructive-foreground transition-[background-color,transform,opacity] duration-150 active:scale-[0.96] hover:bg-destructive/90"
          >
            {isDeleting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                Deleting
              </span>
            ) : (
              'Delete'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
