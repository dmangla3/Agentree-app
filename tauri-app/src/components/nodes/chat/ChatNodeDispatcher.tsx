import React, { memo, useCallback } from 'react';
import { ChatUserCard } from './ChatUserCard';
import { ChatAssistantCard } from './ChatAssistantCard';
import { ChatCommitCard } from './ChatCommitCard';
import { ChatSummaryCard } from './ChatSummaryCard';
import { ChatExternalCommitBatchCard } from './ChatExternalCommitBatchCard';


interface ChatNodeDispatcherProps {
  entityId?: string;
  batchId?: string;
  projection: any; // workspace projection
  scopeColorById?: Map<string, string | null>;
  scopeNameById?: Map<string, string>;
  focusedMessageId: string | null;
  isSelected: boolean;
  selectedMessageIdsSet: Set<string>;
  onFocus: (id: string, metadata?: Record<string, unknown>) => void;
  onSelect: (id: string, multi: boolean) => void;
  onContextMenu: (id: string, e: React.MouseEvent) => void;
}

export const ChatNodeDispatcher = memo(({
  entityId,
  batchId,
  projection,
  scopeColorById,
  scopeNameById,
  focusedMessageId,
  isSelected,
  selectedMessageIdsSet,
  onFocus,
  onSelect,
  onContextMenu
}: ChatNodeDispatcherProps) => {
  const entity = entityId ? projection.entitiesById.get(entityId) : null;
  const batch = batchId ? projection.externalCommitBatchById.get(batchId) : null;

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

  const resolvedScopeColorById = scopeColorById ?? projection.scopeColorById;
  const resolvedScopeNameById = scopeNameById ?? projection.scopeNameById;
  const scopeColor = entity?.scopeId ? resolvedScopeColorById?.get(entity.scopeId) || null : null;
  const scopeName = entity?.scopeId ? resolvedScopeNameById?.get(entity.scopeId) || null : null;
  
  const sharedProps = {
    isFocused: (entity?.focusMessageId === focusedMessageId) || (batch?.messageIds.includes(focusedMessageId || '')),
    isSelected,
    scopeColor,
    scopeName,
    layout: 'chat' as const,
    onFocus: handleFocus,
    onSelect: handleSelect,
    onContextMenu: handleContextMenu,
  };

  if (batch) {
    return (
      <ChatExternalCommitBatchCard
        batch={batch}
        projection={projection}
        isFocused={sharedProps.isFocused}
        isSelected={sharedProps.isSelected}
        scopeColor={sharedProps.scopeColor}
        onFocusCommit={onFocus}
        onSelectCommit={onSelect}
        onContextMenuCommit={onContextMenu}
        selectedCommitIds={selectedMessageIdsSet}
        onContextMenu={handleContextMenu}
      />
    );
  }

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
