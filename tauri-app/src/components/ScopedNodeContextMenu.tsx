import { useEffect, useMemo, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../@/components/ui/dropdown-menu';
import type { WorkspaceProjection } from '../domain/workspaceProjection';
import { getMessageOutputCommitSha } from '../lib/graph/commitAccessors';

export interface ScopedContextMenuState {
  x: number;
  y: number;
  scopedIds: string[];
}

interface ScopedNodeContextMenuProps {
  contextMenu: ScopedContextMenuState | null;
  projection: WorkspaceProjection;
  onClose: () => void;
  onDeleteMessages?: (messageIds: string[]) => void;
  onDeleteTargets?: (targets: { messageIds: string[]; commitShas: string[] }) => void;
  onAddCommitsToMergePanel?: (messageIds: string[]) => void;
  onAddCommitShasToMergePanel?: (commitShas: string[]) => void;
  onAddCommitToNode?: (messageId: string) => void;
  onFocusThread?: (threadRootId: string) => void;
  onHideThread?: (threadRootId: string) => void;
  onHideSubgraph?: (messageId: string) => void;
  onViewSubgraph?: (messageId: string) => void;
  onShareNode?: (messageId: string) => void;
}

export function ScopedNodeContextMenu({
  contextMenu,
  projection,
  onClose,
  onDeleteMessages,
  onDeleteTargets,
  onAddCommitsToMergePanel,
  onAddCommitShasToMergePanel,
  onAddCommitToNode,
  onFocusThread,
  onHideThread,
  onHideSubgraph,
  onViewSubgraph,
  onShareNode,
}: ScopedNodeContextMenuProps) {
  const scopedIds = contextMenu?.scopedIds ?? [];
  const scopedKey = scopedIds.join('\u0000');
  const [hideThreadAfterMerge, setHideThreadAfterMerge] = useState(true);

  useEffect(() => {
    if (contextMenu) setHideThreadAfterMerge(true);
  }, [contextMenu, scopedKey]);

  const { deletableMessageIds, deletableCommitShas, mergeableCommitIds, mergeableCommitShas, actionNodeId, actionThreadRootId, mergeThreadRootId } = useMemo(() => {
    const deletableIds = new Set<string>();
    const deletableShas = new Set<string>();
    const mergeableIds = new Set<string>();
    const mergeableShas = new Set<string>();
    let singleActionId: string | null = null;
    let singleThreadRootId: string | null = null;
    let singleMergeThreadRootId: string | null = null;
    let hasMultipleMergeThreadRoots = false;

    const addMessageId = (messageId: string | null | undefined) => {
      if (messageId) deletableIds.add(messageId);
    };

    const recordMergeThreadRootId = (threadRootId: string | null | undefined) => {
      if (!threadRootId || hasMultipleMergeThreadRoots) return;
      if (!singleMergeThreadRootId) {
        singleMergeThreadRootId = threadRootId;
        return;
      }
      if (singleMergeThreadRootId !== threadRootId) {
        singleMergeThreadRootId = null;
        hasMultipleMergeThreadRoots = true;
      }
    };

    const getThreadRootIdForMessageId = (messageId: string | null | undefined) => {
      if (!messageId) return null;
      return projection.entitiesByMessageId.get(messageId)?.threadRootId
        ?? projection.threadRootIdByMessageId.get(messageId)
        ?? null;
    };

    const getThreadRootIdForCommitSha = (commitSha: string | null | undefined) => {
      if (!commitSha) return null;
      const commit = projection.commitBySha.get(commitSha);
      const ownerNodeId = commit?.producedByNodeId ?? commit?.visualOwnerNodeId ?? null;
      return getThreadRootIdForMessageId(ownerNodeId);
    };

    const addMergeableCommitId = (messageId: string | null | undefined) => {
      if (!messageId) return;
      const entity = projection.entitiesByMessageId.get(messageId);
      if (entity?.kind === 'commit_message' && getMessageOutputCommitSha(entity.message)) {
        mergeableIds.add(messageId);
        recordMergeThreadRootId(entity.threadRootId ?? getThreadRootIdForMessageId(messageId));
      }
    };

    const addMergeableCommitSha = (commitSha: string | null | undefined, explicitCommitToken = false) => {
      if (!commitSha) return;
      if (explicitCommitToken || projection.commitBySha.has(commitSha)) {
        mergeableShas.add(commitSha);
        recordMergeThreadRootId(getThreadRootIdForCommitSha(commitSha));
      }
    };

    for (const id of scopedIds) {
      const entity = projection.entitiesByMessageId.get(id) ?? projection.entitiesById.get(id);

      if (id.startsWith('commit:')) {
        const sha = id.slice('commit:'.length);
        if (projection.commitBySha.has(sha)) deletableShas.add(sha);
        addMergeableCommitSha(sha, true);
      } else if (!entity) {
        addMergeableCommitSha(id);
      }

      if (!entity) continue;
      if (scopedIds.length === 1 && entity.messageId) {
        singleActionId = entity.messageId;
        singleThreadRootId = entity.threadRootId ?? null;
      }

      if (entity.kind === 'user_message' || entity.kind === 'assistant_message' || entity.kind === 'commit_message') {
        addMessageId(entity.messageId);
      }

      if (entity.kind === 'commit_message' && getMessageOutputCommitSha(entity.message)) {
        addMergeableCommitId(entity.messageId);
      }
    }

    return {
      deletableMessageIds: Array.from(deletableIds),
      deletableCommitShas: Array.from(deletableShas),
      mergeableCommitIds: Array.from(mergeableIds),
      mergeableCommitShas: Array.from(mergeableShas),
      actionNodeId: singleActionId,
      actionThreadRootId: singleThreadRootId,
      mergeThreadRootId: hasMultipleMergeThreadRoots ? null : singleMergeThreadRootId,
    };
  }, [projection.commitBySha, projection.entitiesById, projection.entitiesByMessageId, projection.threadRootIdByMessageId, scopedIds]);

  if (!contextMenu) return null;

  const canDelete = (deletableMessageIds.length > 0 || deletableCommitShas.length > 0) && (!!onDeleteTargets || !!onDeleteMessages);
  const canAddToMergePanel = (mergeableCommitIds.length > 0 && !!onAddCommitsToMergePanel)
    || (mergeableCommitShas.length > 0 && !!onAddCommitShasToMergePanel);
  const canAddCommit = !!actionNodeId && !!onAddCommitToNode;
  const canFocusThread = !!actionThreadRootId && !!onFocusThread;
  const canHideThread = !!actionThreadRootId && !!onHideThread;
  const canHideSubgraph = !!actionNodeId && !!onHideSubgraph;
  const canViewSubgraph = !!actionNodeId && !!onViewSubgraph;
  const canShareNode = !!actionNodeId && !!onShareNode;

  if (!canDelete && !canAddToMergePanel && !canAddCommit && !canFocusThread && !canHideThread && !canHideSubgraph && !canViewSubgraph && !canShareNode) {
    return null;
  }

  const deleteCount = deletableMessageIds.length + deletableCommitShas.length;
  const deleteLabel = deleteCount === 1 ? 'Delete Node' : 'Delete Nodes';
  const mergeCount = mergeableCommitIds.length + mergeableCommitShas.length;
  const mergeLabel = mergeCount === 1
    ? 'Add to merge panel'
    : `Add ${mergeCount} commits to merge panel`;
  const canHideThreadAfterMerge = canAddToMergePanel && !!mergeThreadRootId && !!onHideThread;

  return (
    <DropdownMenu
      open={!!contextMenu}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <div
          style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, width: 0, height: 0 }}
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        {canFocusThread ? (
          <DropdownMenuItem
            onClick={() => {
              onFocusThread?.(actionThreadRootId!);
              onClose();
            }}
          >
            Focus thread
          </DropdownMenuItem>
        ) : null}

        {canViewSubgraph ? (
          <DropdownMenuItem
            onClick={() => {
              onViewSubgraph?.(actionNodeId!);
              onClose();
            }}
          >
            View subgraph
          </DropdownMenuItem>
        ) : null}

        {canShareNode ? (
          <DropdownMenuItem
            onClick={() => {
              onShareNode?.(actionNodeId!);
              onClose();
            }}
          >
            Share node subgraph
          </DropdownMenuItem>
        ) : null}

        {canHideThread ? (
          <DropdownMenuItem
            onClick={() => {
              onHideThread?.(actionThreadRootId!);
              onClose();
            }}
          >
            Hide thread
          </DropdownMenuItem>
        ) : null}

        {canHideSubgraph ? (
          <DropdownMenuItem
            onClick={() => {
              onHideSubgraph?.(actionNodeId!);
              onClose();
            }}
          >
            Hide subgraph
          </DropdownMenuItem>
        ) : null}

        {canAddCommit ? (
          <DropdownMenuItem
            onClick={() => {
              onAddCommitToNode?.(actionNodeId!);
              onClose();
            }}
          >
            Add commit...
          </DropdownMenuItem>
        ) : null}

        {canAddToMergePanel ? (
          <div
            role="group"
            aria-label="Merge panel action"
            className="my-0.5 rounded-md bg-muted/55 p-1 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55),inset_0_1px_0_hsl(var(--foreground)/0.04)]"
          >
            <DropdownMenuItem
              className="rounded-[5px] px-2 py-1.5 font-medium"
              onClick={() => {
                if (mergeableCommitIds.length > 0) {
                  onAddCommitsToMergePanel?.(mergeableCommitIds);
                }
                if (mergeableCommitShas.length > 0) {
                  onAddCommitShasToMergePanel?.(mergeableCommitShas);
                }
                if (canHideThreadAfterMerge && hideThreadAfterMerge) {
                  onHideThread?.(mergeThreadRootId!);
                }
                onClose();
              }}
            >
              {mergeLabel}
            </DropdownMenuItem>
            {canHideThreadAfterMerge ? (
              <DropdownMenuCheckboxItem
                checked={hideThreadAfterMerge}
                className="mt-0.5 min-h-7 rounded-[5px] py-1 pl-7 pr-2 text-xs text-muted-foreground focus:bg-background/80 focus:text-foreground"
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => setHideThreadAfterMerge(checked === true)}
              >
                Hide thread
              </DropdownMenuCheckboxItem>
            ) : null}
          </div>
        ) : null}

        {canDelete ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => {
              if (onDeleteTargets) {
                onDeleteTargets({ messageIds: deletableMessageIds, commitShas: deletableCommitShas });
              } else {
                onDeleteMessages?.(deletableMessageIds);
              }
              onClose();
            }}
          >
            {deleteLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ScopedNodeContextMenu;
