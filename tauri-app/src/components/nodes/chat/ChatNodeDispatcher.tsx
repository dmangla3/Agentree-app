import React, { memo, useCallback } from 'react';
import { ChatUserCard } from './ChatUserCard';
import { ChatAssistantCard } from './ChatAssistantCard';
import { ChatCommitCard } from './ChatCommitCard';
import { ChatSummaryCard } from './ChatSummaryCard';
import type { ProjectedNodeEntity } from '../../../domain/workspaceProjection';


interface ChatNodeDispatcherProps {
  entityId?: string;
  entityOverride?: ProjectedNodeEntity;
  projection: any; // workspace projection
  focusedMessageId: string | null;
  isSelected: boolean;
  onFocus: (id: string, metadata?: Record<string, unknown>) => void;
  onSelect: (id: string, multi: boolean) => void;
  onContextMenu: (id: string, e: React.MouseEvent) => void;
}

export const ChatNodeDispatcher = memo(({
  entityId,
  entityOverride,
  projection,
  focusedMessageId,
  isSelected,
  onFocus,
  onSelect,
  onContextMenu
}: ChatNodeDispatcherProps) => {
  const entity = entityOverride ?? (entityId ? projection.entitiesById.get(entityId) : null);

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
    scopeName: null,
    layout: 'chat' as const,
    onFocus: handleFocus,
    onSelect: handleSelect,
    onContextMenu: handleContextMenu,
  };

  if (!entity) return null;

  switch (entity.kind) {
    case 'user_message':
      return <ChatUserCard {...sharedProps} entity={entity} />;
    case 'assistant_message':
      return <ChatAssistantCard {...sharedProps} entity={entity} />;
    case 'commit_message':
      return <ChatCommitCard {...sharedProps} entity={entity} />;
    case 'summary_block':
      return <ChatSummaryCard {...sharedProps} entity={entity} />;
    default:
      return null;
  }
});

ChatNodeDispatcher.displayName = 'ChatNodeDispatcher';
