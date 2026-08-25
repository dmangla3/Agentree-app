import { memo, useCallback } from 'react';
import { ListUserRow } from './ListUserRow';
import { ListAssistantRow } from './ListAssistantRow';
import { ListCommitRow } from './ListCommitRow';
import { ListSummaryRow } from './ListSummaryRow';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { NodeHoverCardContent } from '../../NodeHoverCardContent';


interface ListNodeDispatcherProps {
  entityId?: string;
  rowId?: string;
  projection: any; // workspace projection
  isSelected: boolean;
  showSelectionControl?: boolean;
  onFocus: (id: string, metadata?: Record<string, unknown>) => void;
  onSelect: (id: string, multi: boolean) => void;
  onContextMenu: (id: string, e: React.MouseEvent) => void;
}

export const ListNodeDispatcher = memo(({
  entityId,
  rowId,
  projection,
  isSelected,
  showSelectionControl = false,
  onFocus,
  onSelect,
  onContextMenu
}: ListNodeDispatcherProps) => {
  const { focusedMessageId } = useWorkspaceStore();

  const entity = entityId ? projection.entitiesById.get(entityId) : null;
  const hoverEntity = entity;

  const handleFocus = useCallback(() => {
    if (entity?.focusMessageId) {
      onFocus(entity.focusMessageId);
    }
  }, [entity, onFocus]);

  const handleSelect = useCallback((multi: boolean) => {
    const id = entity?.messageId || entity?.summary?.id;
    if (id) {
      onSelect(id, multi);
    }
  }, [entity, onSelect]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const id = entity?.messageId || entity?.summary?.id;
    if (id) {
      onContextMenu(id, e);
    }
  }, [entity, onContextMenu]);

  const sharedProps = {
    isFocused: entity?.focusMessageId === focusedMessageId,
    isSelected,
    layout: 'list' as const,
    hoverCardContent: <NodeHoverCardContent entity={hoverEntity} projection={projection} />,
    onFocus: handleFocus,
    onSelect: handleSelect,
    onContextMenu: handleContextMenu,
  };

  if (!entity) return null;

  switch (entity.kind) {
    case 'user_message':
      return <ListUserRow {...sharedProps} nodeId={rowId} entity={entity} showSelectionControl={showSelectionControl} />;
    case 'assistant_message':
      return <ListAssistantRow {...sharedProps} nodeId={rowId} entity={entity} showSelectionControl={showSelectionControl} />;
    case 'commit_message':
      return <ListCommitRow {...sharedProps} nodeId={rowId} entity={entity} showSelectionControl={showSelectionControl} />;
    case 'summary_block':
      return <ListSummaryRow {...sharedProps} nodeId={rowId} entity={entity} showSelectionControl={showSelectionControl} />;
    default:
      return null;
  }
});

ListNodeDispatcher.displayName = 'ListNodeDispatcher';
