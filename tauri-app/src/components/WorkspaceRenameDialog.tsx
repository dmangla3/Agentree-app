import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Workspace } from '../stores/workspaceStore';
import { Button } from '../../@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../@/components/ui/dialog';
import { Input } from '../../@/components/ui/input';
import { Label } from '../../@/components/ui/label';

interface WorkspaceRenameDialogProps {
  workspace: Workspace | null;
  isRenaming?: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (workspace: Workspace, name: string) => Promise<void>;
}

export function WorkspaceRenameDialog({
  workspace,
  isRenaming = false,
  onOpenChange,
  onRename,
}: WorkspaceRenameDialogProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(workspace?.name ?? '');
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    const timeout = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [workspace]);

  const trimmedName = name.trim();
  const canSubmit = Boolean(workspace && trimmedName && trimmedName !== workspace.name && !isRenaming);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspace || !canSubmit) return;
    await onRename(workspace, trimmedName);
  };

  return (
    <Dialog open={workspace !== null} onOpenChange={onOpenChange}>
      <DialogContent data-design-scope="panels" className="gap-0 overflow-hidden rounded-xl border-[hsl(var(--app-border)/0.68)] bg-[hsl(var(--app-panel))] p-0 shadow-[0_24px_64px_-32px_hsl(var(--foreground)/0.5)] dark:border-white/10 dark:bg-[hsl(var(--app-panel))]">
        <DialogHeader className="border-b border-[hsl(var(--app-border)/0.68)] px-5 py-4 text-left dark:border-white/10">
          <DialogTitle>Rename workspace</DialogTitle>
          <DialogDescription>Choose a clear name for this workspace.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-2 px-5 py-4">
            <Label htmlFor="workspace-name">Workspace name</Label>
            <Input
              id="workspace-name"
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={isRenaming}
              className="h-10 rounded-lg dark:border-white/15 dark:bg-white/[0.04]"
            />
          </div>
          <DialogFooter className="border-t border-[hsl(var(--app-border)/0.68)] px-5 py-3 dark:border-white/10">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="h-10 rounded-lg active:scale-[0.96]"
              disabled={isRenaming}
            >
              Cancel
            </Button>
            <Button type="submit" className="h-10 rounded-lg active:scale-[0.96] dark:bg-white dark:text-black dark:hover:bg-white/90" disabled={!canSubmit}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
