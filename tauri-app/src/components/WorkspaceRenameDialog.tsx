import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Workspace } from '../stores/workspaceStore';
import { Button } from '../../@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../@/components/ui/dialog';
import { Input } from '../../@/components/ui/input';

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename Workspace</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <Input
            ref={inputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={isRenaming}
            aria-label="Workspace name"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isRenaming}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
