import { memo, useCallback } from 'react';
import { TimelineUserRow } from './TimelineUserRow';
import { TimelineAssistantRow } from './TimelineAssistantRow';
import { TimelineCommitRow } from './TimelineCommitRow';
import { TimelineSummaryRow } from './TimelineSummaryRow';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { NodeHoverCardContent } from '../../NodeHoverCardContent';


interface TimelineNodeDispatcherProps {
  entityId?: string;
  rowId?: string;
  projection: any; // workspace projection
  isSelected: boolean;
  showSelectionControl?: boolean;
  onFocus: (id: string, metadata?: Record<string, unknown>) => void;
  onSelect: (id: string, multi: boolean) => void;
  onContextMenu: (id: string, e: React.MouseEvent) => void;
}

export const TimelineNodeDispatcher = memo(({
  entityId,
  rowId,
  projection,
  isSelected,
  showSelectionControl = false,
  onFocus,
  onSelect,
  onContextMenu
}: TimelineNodeDispatcherProps) => {
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
    scopeColor: null,
    layout: 'timeline' as const,
    hoverCardContent: <NodeHoverCardContent entity={hoverEntity} projection={projection} />,
    onFocus: handleFocus,
    onSelect: handleSelect,
    onContextMenu: handleContextMenu,
  };

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
