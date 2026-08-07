import { useMemo } from 'react';
import {
  DropdownMenu,
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
  onAddCommitToNode?: (messageId: string) => void;
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
  onAddCommitToNode,
  onViewSubgraph,
  onShareNode,
}: ScopedNodeContextMenuProps) {
  const scopedIds = contextMenu?.scopedIds ?? [];

  const { deletableMessageIds, deletableCommitShas, mergeableCommitIds, actionNodeId } = useMemo(() => {
    const deletableIds = new Set<string>();
    const deletableShas = new Set<string>();
    const mergeableIds = new Set<string>();
    let singleActionId: string | null = null;

    const addMessageId = (messageId: string | null | undefined) => {
      if (messageId) deletableIds.add(messageId);
    };

    const addMergeableCommitId = (messageId: string | null | undefined) => {
      if (!messageId) return;
      const entity = projection.entitiesByMessageId.get(messageId);
      if (entity?.kind === 'commit_message' && getMessageOutputCommitSha(entity.message)) {
        mergeableIds.add(messageId);
      }
    };

    for (const id of scopedIds) {
      if (id.startsWith('commit:')) {
        const sha = id.slice('commit:'.length);
        if (projection.commitBySha.has(sha)) deletableShas.add(sha);
      }

      const entity = projection.entitiesByMessageId.get(id) ?? projection.entitiesById.get(id);
      if (!entity) continue;
      if (scopedIds.length === 1 && entity.messageId) {
        singleActionId = entity.messageId;
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
      actionNodeId: singleActionId,
    };
  }, [projection.commitBySha, projection.entitiesById, projection.entitiesByMessageId, scopedIds]);

  if (!contextMenu) return null;

  const canDelete = (deletableMessageIds.length > 0 || deletableCommitShas.length > 0) && (!!onDeleteTargets || !!onDeleteMessages);
  const canAddToMergePanel = mergeableCommitIds.length > 0 && !!onAddCommitsToMergePanel;
  const canAddCommit = !!actionNodeId && !!onAddCommitToNode;
  const canViewSubgraph = !!actionNodeId && !!onViewSubgraph;
  const canShareNode = !!actionNodeId && !!onShareNode;

  if (!canDelete && !canAddToMergePanel && !canAddCommit && !canViewSubgraph && !canShareNode) {
    return null;
  }

  const deleteCount = deletableMessageIds.length + deletableCommitShas.length;
  const deleteLabel = deleteCount === 1 ? 'Delete Node' : 'Delete Nodes';
  const mergeLabel = mergeableCommitIds.length === 1
    ? 'Add to merge panel'
    : `Add ${mergeableCommitIds.length} commits to merge panel`;

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
          <DropdownMenuItem
            onClick={() => {
              onAddCommitsToMergePanel?.(mergeableCommitIds);
              onClose();
            }}
          >
            {mergeLabel}
          </DropdownMenuItem>
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
