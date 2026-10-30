import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, GitBranch, Loader2 } from 'lucide-react';
import { Button } from '../../@/components/ui/button';
import { Checkbox } from '../../@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '../../@/components/ui/popover';
import { Badge } from '../../@/components/ui/badge';
import { Message } from '../stores/workspaceStore';
import { useBranches, useUpdateBranch, branchKeys } from '../hooks/useBranches';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { useMessages } from '../hooks/useMessages';
import { agentClient } from '../lib/agentClient';
import { getGraphParentId } from '../lib/graph/lineage';
import { isFirstClassCommitMessage } from '../lib/graph/turnUtils';
import { getBranchPointerCommitSha, getMessageOutputCommitSha } from '../lib/graph/commitAccessors';
import { useToast } from './Toast';
import { cn } from '../lib/utils';

interface ParentRefMoveActionProps {
  message: Message;
  workspaceId: string;
  repoPath?: string | null;
  visible?: boolean;
  className?: string;
}

const isExternalCommit = (message: Message): boolean => {
  const executionData = message.execution_data as Record<string, unknown> | undefined;
  return (executionData?.meta as Record<string, unknown> | undefined)?.sync_source === 'external_git';
};

const getNodeLabel = (message: Message | null | undefined): string => {
  if (!message) return 'parent';
  if (message.aiLabel && message.aiLabel.trim()) return message.aiLabel.trim();
  const outputCommitSha = getMessageOutputCommitSha(message);
  if (outputCommitSha) return outputCommitSha.slice(0, 7);
  const text = (message.content || '').trim().replace(/\s+/g, ' ');
  if (text.length > 0) return text.slice(0, 32);
  return message.id.slice(0, 8);
};

export function ParentRefMoveAction({
  message,
  workspaceId,
  repoPath: repoPathProp = null,
  visible = true,
  className,
}: ParentRefMoveActionProps) {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const updateBranchMutation = useUpdateBranch();
  const { data: branches = [] } = useBranches(workspaceId);
  const { data: workspaces = [] } = useWorkspaces();
  const { data: messages = [] } = useMessages(workspaceId);
  const [open, setOpen] = useState(false);
  const [selectedPointerIds, setSelectedPointerIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const messageMap = useMemo(
    () => new Map(messages.map((entry) => [entry.id, entry])),
    [messages],
  );

  const repoPath = useMemo(() => {
    if (repoPathProp) return repoPathProp;
    const workspace = workspaces.find((entry) => entry.id === workspaceId) ?? null;
    return workspace?.git_repo_path ?? workspace?.folderPath ?? null;
  }, [workspaceId, workspaces, repoPathProp]);

  const isEligibleCommit = useMemo(() => {
    if (!visible) return false;
    if (message.role !== 'assistant') return false;
    if (!getMessageOutputCommitSha(message)) return false;
    if (isExternalCommit(message)) return false;
    return isFirstClassCommitMessage(message, { messageMap });
  }, [message, messageMap, visible]);

  const parentMessage = useMemo(() => {
    if (!isEligibleCommit) return null;
    const parentId = getGraphParentId(message, messageMap);
    if (!parentId) return null;
    return messageMap.get(parentId) ?? null;
  }, [isEligibleCommit, message, messageMap]);

  const matchPointersToMessage = useMemo(() => {
    return (target: Message | null | undefined) => {
      if (!target) return [];
      return branches.filter((pointer) => {
        const targetCommitSha = getMessageOutputCommitSha(target);
        if (!targetCommitSha) return false;
        return getBranchPointerCommitSha(pointer) === targetCommitSha;
      });
    };
  }, [branches]);

  const currentPointerIds = useMemo(() => {
    return new Set(matchPointersToMessage(message).map((pointer) => pointer.id));
  }, [matchPointersToMessage, message]);

  const availablePointers = useMemo(() => {
    return matchPointersToMessage(parentMessage).filter((pointer) => !currentPointerIds.has(pointer.id));
  }, [currentPointerIds, matchPointersToMessage, parentMessage]);

  useEffect(() => {
    if (!open) return;
    setSelectedPointerIds(availablePointers.map((pointer) => pointer.id));
  }, [availablePointers, open]);

  const selectedPointers = useMemo(() => {
    const selectedSet = new Set(selectedPointerIds);
    return availablePointers.filter((pointer) => selectedSet.has(pointer.id));
  }, [availablePointers, selectedPointerIds]);

  const actionLabel = availablePointers.length === 1
    ? `Move ${availablePointers[0]?.name ?? 'ref'} here`
    : 'Move Parent Refs';

  const buttonDisabled = !repoPath || !isEligibleCommit || !parentMessage || availablePointers.length === 0 || isSubmitting;

  if (buttonDisabled) return null;

  const togglePointer = (pointerId: string, checked: boolean) => {
    setSelectedPointerIds((current) => {
      if (checked) {
        return current.includes(pointerId) ? current : [...current, pointerId];
      }
      return current.filter((id) => id !== pointerId);
    });
  };

  const summarizeFailure = (name: string, error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('cannot lock ref') || message.includes('update-ref')) {
      return `${name}: ref changed since this view loaded`;
    }
    if (message.toLowerCase().includes('moved since')) {
      return `${name}: pointer changed since this view loaded`;
    }
    return `${name}: ${message}`;
  };

  const handleMove = async () => {
    const targetCommitSha = getMessageOutputCommitSha(message);
    if (!repoPath || !targetCommitSha || selectedPointers.length === 0) return;

    setIsSubmitting(true);
    const succeeded: string[] = [];
    const failed: string[] = [];

    for (const pointer of selectedPointers) {
      const expectedCurrentSha = getBranchPointerCommitSha(pointer);
      try {
        await agentClient.updateGitRef(repoPath, pointer.git_ref, targetCommitSha, expectedCurrentSha);
        try {
          await updateBranchMutation.mutateAsync({
            workspaceId,
            branchId: pointer.id,
            commitSha: targetCommitSha,
            expectedCommitSha: expectedCurrentSha ?? undefined,
          });
          succeeded.push(pointer.name);
        } catch (error) {
          if (expectedCurrentSha) {
            await agentClient.updateGitRef(repoPath, pointer.git_ref, expectedCurrentSha).catch(() => undefined);
          }
          failed.push(summarizeFailure(pointer.name, error));
        }
      } catch (error) {
        failed.push(summarizeFailure(pointer.name, error));
      }
    }

    setIsSubmitting(false);
    setOpen(false);
    queryClient.invalidateQueries({ queryKey: branchKeys.workspace(workspaceId) });
    queryClient.invalidateQueries({ queryKey: ['messages', workspaceId], refetchType: 'none' });

    if (succeeded.length > 0 && failed.length === 0) {
      addToast({
        title: succeeded.length === 1 ? 'Ref Moved' : 'Refs Moved',
        description: succeeded.length === 1
          ? `${succeeded[0]} now points to ${targetCommitSha.slice(0, 7)}.`
          : `${succeeded.join(', ')} now point to ${targetCommitSha.slice(0, 7)}.`,
        variant: 'success',
      });
      return;
    }

    if (succeeded.length > 0 || failed.length > 0) {
      const summaryParts = [
        succeeded.length > 0 ? `Moved: ${succeeded.join(', ')}` : null,
        failed.length > 0 ? `Skipped: ${failed.join('; ')}` : null,
      ].filter(Boolean);

      addToast({
        title: failed.length > 0 ? 'Pointer Move Partial' : 'Ref Move Complete',
        description: summaryParts.join('  '),
        variant: failed.length > 0 ? 'warning' : 'success',
        duration: 9000,
      });
    }
  };

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !isSubmitting && setOpen(nextOpen)}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn('h-10 gap-1.5 rounded-lg text-[11px] transition-transform duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none', className)}
          onClick={(event) => event.stopPropagation()}
        >
          <GitBranch className="h-3 w-3" />
          <span>{actionLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <div className="text-balance text-sm font-semibold text-foreground">Move parent refs</div>
            <div className="text-pretty text-xs leading-5 text-muted-foreground">
              Select which refs to retarget from <span className="font-medium text-foreground">{getNodeLabel(parentMessage)}</span> to{' '}
              <span className="font-mono text-foreground">{getMessageOutputCommitSha(message)?.slice(0, 7)}</span>.
            </div>
          </div>

          <div className="space-y-2">
            {availablePointers.map((pointer) => {
              const checked = selectedPointerIds.includes(pointer.id);
              return (
                <label
                  key={pointer.id}
                  className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border border-border/65 px-2.5 py-2 text-sm transition-colors duration-150 ease-out hover:bg-muted/45 motion-reduce:transition-none"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(value) => togglePointer(pointer.id, value === true)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">{pointer.name}</span>
                      {pointer.is_ship_path ? (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px] uppercase">
                          ship
                        </Badge>
                      ) : null}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{pointer.git_ref}</div>
                  </div>
                </label>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-10 rounded-lg transition-transform duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none"
              onClick={() => setOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleMove}
              disabled={selectedPointers.length === 0 || isSubmitting}
              className="min-h-10 gap-1.5 rounded-lg transition-transform duration-150 ease-out active:scale-[0.96] motion-reduce:transition-none"
            >
              {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <ArrowRight className="h-3.5 w-3.5" />}
              <span>{selectedPointers.length === 1 ? 'Move 1 Ref' : `Move ${selectedPointers.length} Refs`}</span>
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
