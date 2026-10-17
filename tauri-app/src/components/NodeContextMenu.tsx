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
import { useWorkspaceStore } from '../stores/workspaceStore';
import { copyAgentreeLink } from '../lib/agentreeDeepLinks';

export interface NodeContextMenuState {
  x: number;
  y: number;
  targetIds: string[];
}

interface NodeContextMenuProps {
  contextMenu: NodeContextMenuState | null;
  projection: WorkspaceProjection;
  onClose: () => void;
  onDeleteMessages?: (messageIds: string[]) => void;
  onDeleteTargets?: (targets: { messageIds: string[]; commitShas: string[] }) => void;
  onAddCommitsToMergePanel?: (messageIds: string[]) => void;
  onAddCommitShasToMergePanel?: (commitShas: string[]) => void;
  onAddCommitToNode?: (messageId: string) => void;
  onFocusThread?: (threadRootId: string) => void;
  onMarkThreadDone?: (threadRootId: string) => void;
  onHideSubgraph?: (messageId: string) => void;
  onViewSubgraph?: (messageId: string) => void;
  onConvertSubgraphToThread?: (messageId: string) => void;
  onShareNode?: (messageId: string) => void;
}

export interface NodeContextMenuActions {
  deletableMessageIds: string[];
  deletableCommitShas: string[];
  mergeableCommitIds: string[];
  mergeableCommitShas: string[];
  actionNodeId: string | null;
  actionThreadRootId: string | null;
  convertSubgraphNodeId: string | null;
  mergeThreadRootId: string | null;
}

export function resolveNodeContextMenuActions(
  projection: WorkspaceProjection,
  targetIds: string[],
): NodeContextMenuActions {
  const deletableIds = new Set<string>();
  const deletableShas = new Set<string>();
  const mergeableIds = new Set<string>();
  const mergeableShas = new Set<string>();
  let singleActionId: string | null = null;
  let singleThreadRootId: string | null = null;
  let singleConvertSubgraphNodeId: string | null = null;
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
    if (commit) return commit.ownerThreadRootId;

    for (const entity of projection.entitiesByMessageId.values()) {
      if (getMessageOutputCommitSha(entity.message) !== commitSha) continue;
      const entityThreadRootId = entity.threadRootId ?? getThreadRootIdForMessageId(entity.messageId);
      if (entityThreadRootId) return entityThreadRootId;
    }

    return null;
  };

  const resolveCommitToken = (token: string | null | undefined): { commitSha: string; threadRootId: string | null } | null => {
    if (!token) return null;
    const commit = projection.commitBySha.get(token);
    if (commit) {
      return {
        commitSha: token,
        threadRootId: getThreadRootIdForCommitSha(token),
      };
    }

    const tokenEntity = projection.entitiesByMessageId.get(token) ?? projection.entitiesById.get(token);
    const tokenMessage = tokenEntity?.message ?? projection.messageMap.get(token) ?? null;
    const tokenOutputCommitSha = getMessageOutputCommitSha(tokenMessage);
    if (tokenOutputCommitSha) {
      return {
        commitSha: tokenOutputCommitSha,
        threadRootId: getThreadRootIdForCommitSha(tokenOutputCommitSha)
          ?? tokenEntity?.threadRootId
          ?? getThreadRootIdForMessageId(tokenEntity?.messageId ?? token),
      };
    }

    for (const entity of projection.entitiesByMessageId.values()) {
      if (getMessageOutputCommitSha(entity.message) !== token) continue;
      return {
        commitSha: token,
        threadRootId: entity.threadRootId ?? getThreadRootIdForMessageId(entity.messageId),
      };
    }

    return null;
  };

  const addMergeableCommitId = (messageId: string | null | undefined) => {
    if (!messageId) return;
    const entity = projection.entitiesByMessageId.get(messageId);
    if (entity?.kind === 'commit_message' && getMessageOutputCommitSha(entity.message)) {
      mergeableIds.add(messageId);
      recordMergeThreadRootId(entity.threadRootId ?? getThreadRootIdForMessageId(messageId));
    }
  };

  const addMergeableCommitSha = (commitToken: string | null | undefined, explicitCommitToken = false) => {
    if (!commitToken) return;
    const resolved = resolveCommitToken(commitToken);
    if (resolved) {
      mergeableShas.add(resolved.commitSha);
      recordMergeThreadRootId(resolved.threadRootId);
      return;
    }
    if (explicitCommitToken) {
      mergeableShas.add(commitToken);
    }
  };

  for (const id of targetIds) {
    const entity = projection.entitiesByMessageId.get(id) ?? projection.entitiesById.get(id);

    if (id.startsWith('commit:')) {
      const sha = id.slice('commit:'.length);
      if (projection.commitBySha.has(sha)) deletableShas.add(sha);
      addMergeableCommitSha(sha, true);
    } else if (!entity) {
      addMergeableCommitSha(id);
    }

    if (!entity) continue;
    if (targetIds.length === 1 && entity.messageId) {
      singleActionId = entity.messageId;
      singleThreadRootId = entity.kind === 'thread_link'
        ? entity.threadLinkRootId ?? entity.threadRootId ?? null
        : entity.threadRootId ?? null;
      if (
        entity.kind === 'user_message' &&
        entity.message?.parentId &&
        !entity.isThreadRoot
      ) {
        singleConvertSubgraphNodeId = entity.messageId;
      }
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
    convertSubgraphNodeId: singleConvertSubgraphNodeId,
    mergeThreadRootId: hasMultipleMergeThreadRoots ? null : singleMergeThreadRootId,
  };
}

export function NodeContextMenu({
  contextMenu,
  projection,
  onClose,
  onDeleteMessages,
  onDeleteTargets,
  onAddCommitsToMergePanel,
  onAddCommitShasToMergePanel,
  onAddCommitToNode,
  onFocusThread,
  onMarkThreadDone,
  onHideSubgraph,
  onViewSubgraph,
  onConvertSubgraphToThread,
  onShareNode,
}: NodeContextMenuProps) {
  const selectedWorkspaceId = useWorkspaceStore((state) => state.selectedWorkspaceId);
  const targetIds = contextMenu?.targetIds ?? [];
  const targetKey = targetIds.join('\u0000');
  const [markThreadDoneAfterMerge, setMarkThreadDoneAfterMerge] = useState(true);

  useEffect(() => {
    if (contextMenu) setMarkThreadDoneAfterMerge(true);
  }, [contextMenu, targetKey]);

  const { deletableMessageIds, deletableCommitShas, mergeableCommitIds, mergeableCommitShas, actionNodeId, actionThreadRootId, convertSubgraphNodeId, mergeThreadRootId } = useMemo(
    () => resolveNodeContextMenuActions(projection, targetIds),
    [projection, targetKey],
  );

  if (!contextMenu) return null;

  const canDelete = (deletableMessageIds.length > 0 || deletableCommitShas.length > 0) && (!!onDeleteTargets || !!onDeleteMessages);
  const canAddToMergePanel = (mergeableCommitIds.length > 0 && !!onAddCommitsToMergePanel)
    || (mergeableCommitShas.length > 0 && !!onAddCommitShasToMergePanel);
  const canAddCommit = !!actionNodeId && !!onAddCommitToNode;
  const canFocusThread = !!actionThreadRootId && !!onFocusThread;
  const canMarkThreadDone = !!actionThreadRootId && !!onMarkThreadDone;
  const canHideSubgraph = !!actionNodeId && !!onHideSubgraph;
  const canViewSubgraph = !!actionNodeId && !!onViewSubgraph;
  const canConvertSubgraphToThread = !!convertSubgraphNodeId && !!onConvertSubgraphToThread;
  const canShareNode = !!actionNodeId && !!onShareNode;
  const canCopyLink = !!selectedWorkspaceId && !!actionNodeId;

  if (!canDelete && !canAddToMergePanel && !canAddCommit && !canFocusThread && !canMarkThreadDone && !canHideSubgraph && !canViewSubgraph && !canConvertSubgraphToThread && !canShareNode && !canCopyLink) {
    return null;
  }

  const deleteCount = deletableMessageIds.length + deletableCommitShas.length;
  const deleteLabel = deleteCount === 1 ? 'Delete Node' : 'Delete Nodes';
  const mergeCount = mergeableCommitIds.length + mergeableCommitShas.length;
  const mergeLabel = mergeCount === 1
    ? 'Add to merge panel'
    : `Add ${mergeCount} commits to merge panel`;
  const canMarkThreadDoneAfterMerge = canAddToMergePanel && !!mergeThreadRootId && !!onMarkThreadDone;

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
        {canCopyLink ? (
          <DropdownMenuItem
            onClick={() => {
              void copyAgentreeLink({ workspaceId: selectedWorkspaceId!, nodeId: actionNodeId! });
              onClose();
            }}
          >
            Copy link
          </DropdownMenuItem>
        ) : null}

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

        {canConvertSubgraphToThread ? (
          <DropdownMenuItem
            onClick={() => {
              onConvertSubgraphToThread?.(convertSubgraphNodeId!);
              onClose();
            }}
          >
            Convert subgraph to thread
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

        {canMarkThreadDone ? (
          <DropdownMenuItem
            onClick={() => {
              onMarkThreadDone?.(actionThreadRootId!);
              onClose();
            }}
          >
            Close thread
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
                if (canMarkThreadDoneAfterMerge && markThreadDoneAfterMerge) {
                  onMarkThreadDone?.(mergeThreadRootId!);
                }
                onClose();
              }}
            >
              {mergeLabel}
            </DropdownMenuItem>
            {canMarkThreadDoneAfterMerge ? (
              <DropdownMenuCheckboxItem
                checked={markThreadDoneAfterMerge}
                className="mt-0.5 min-h-7 rounded-[5px] py-1 pl-7 pr-2 text-xs text-muted-foreground focus:bg-background/80 focus:text-foreground"
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => setMarkThreadDoneAfterMerge(checked === true)}
              >
                Close thread
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

export default NodeContextMenu;
