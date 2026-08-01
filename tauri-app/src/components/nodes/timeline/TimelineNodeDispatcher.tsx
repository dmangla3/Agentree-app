import { memo, useCallback } from 'react';
import { TimelineUserRow } from './TimelineUserRow';
import { TimelineAssistantRow } from './TimelineAssistantRow';
import { TimelineCommitRow } from './TimelineCommitRow';
import { TimelineSummaryRow } from './TimelineSummaryRow';
import { TimelineExternalCommitBatchRow } from './TimelineExternalCommitBatchRow';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { NodeHoverCardContent } from '../../NodeHoverCardContent';


interface TimelineNodeDispatcherProps {
  entityId?: string;
  batchId?: string;
  rowId?: string;
  projection: any; // workspace projection
  scopeColorById?: Map<string, string | null>;
  isSelected: boolean;
  showSelectionControl?: boolean;
  selectedNodeIds?: Set<string>;
  onFocus: (id: string, metadata?: Record<string, unknown>) => void;
  onSelect: (id: string, multi: boolean) => void;
  onContextMenu: (id: string, e: React.MouseEvent) => void;
}

export const TimelineNodeDispatcher = memo(({
  entityId,
  batchId,
  rowId,
  projection,
  scopeColorById,
  isSelected,
  showSelectionControl = false,
  selectedNodeIds = new Set<string>(),
  onFocus,
  onSelect,
  onContextMenu
}: TimelineNodeDispatcherProps) => {
  const { focusedMessageId } = useWorkspaceStore();

  const entity = entityId ? projection.entitiesById.get(entityId) : null;
  const batch = batchId ? projection.externalCommitBatchById.get(batchId) : null;
  const hoverEntity = entity
    ?? (batch?.representativeMessageId
      ? projection.entitiesByMessageId.get(batch.representativeMessageId)
      : undefined);

  const handleFocus = useCallback(() => {
    if (entity?.focusMessageId) {
      onFocus(entity.focusMessageId);
    } else if (batch?.representativeMessageId) {
      onFocus(batch.representativeMessageId);
    }
  }, [entity, batch, onFocus]);

  const handleSelect = useCallback((multi: boolean) => {
    const id = entity?.messageId || entity?.summary?.id;
    if (id) {
      onSelect(id, multi);
    }
  }, [entity, onSelect]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const id = entity?.messageId || entity?.summary?.id || batch?.entityId;
    if (id) {
      onContextMenu(id, e);
    }
  }, [entity, batch, onContextMenu]);

  // Get scope color from the map (DB stored color)
  const scopeColor = entity?.scopeId ? scopeColorById?.get(entity.scopeId) || null : null;
  
  const sharedProps = {
    isFocused: (entity?.focusMessageId === focusedMessageId) || (batch?.messageIds.includes(focusedMessageId || '')),
    isSelected,
    scopeColor,
    layout: 'timeline' as const,
    hoverCardContent: <NodeHoverCardContent entity={hoverEntity} projection={projection} />,
    onFocus: handleFocus,
    onSelect: handleSelect,
    onContextMenu: handleContextMenu,
  };

  if (batch) {
    return (
      <TimelineExternalCommitBatchRow
        batch={batch}
        rowId={rowId}
        isFocused={sharedProps.isFocused}
        isSelected={sharedProps.isSelected}
        focusedCommitId={focusedMessageId}
        scopeColor={sharedProps.scopeColor}
        onFocusCommit={onFocus}
        onSelect={onSelect}
        onContextMenu={handleContextMenu}
        showSelectionControl={showSelectionControl}
        selectedCommitIds={selectedNodeIds}
        hoverCardContent={sharedProps.hoverCardContent}
      />
    );
  }

  if (!entity) return null;

  switch (entity.kind) {
    case 'user_message':
      return <TimelineUserRow {...sharedProps} nodeId={rowId} entity={entity} showSelectionControl={showSelectionControl} />;
    case 'assistant_message':
      return <TimelineAssistantRow {...sharedProps} nodeId={rowId} entity={entity} showSelectionControl={showSelectionControl} />;
    case 'commit_message':
      return <TimelineCommitRow {...sharedProps} nodeId={rowId} entity={entity} showSelectionControl={showSelectionControl} />;
    case 'summary_block':
      return <TimelineSummaryRow {...sharedProps} nodeId={rowId} entity={entity} showSelectionControl={showSelectionControl} />;
    default:
      return null;
  }
});

TimelineNodeDispatcher.displayName = 'TimelineNodeDispatcher';
