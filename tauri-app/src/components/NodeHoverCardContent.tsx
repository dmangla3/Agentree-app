import { useWorkspaceStore } from '../stores/workspaceStore';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../domain/workspaceProjection';
import { ChatNodeDispatcher } from './nodes/chat/ChatNodeDispatcher';
import { Button } from '../../@/components/ui/button';
import { Reply } from 'lucide-react';

const EMPTY_SELECTED_MESSAGE_IDS = new Set<string>();

interface NodeHoverCardContentProps {
  entity?: ProjectedNodeEntity;
  projection?: WorkspaceProjection;
}

export function NodeHoverCardContent({ entity, projection }: NodeHoverCardContentProps) {
  const openFloatingChatInput = useWorkspaceStore((state) => state.openFloatingChatInput);
  if (!entity || !projection) return null;
  const replyParentId = entity.focusMessageId || entity.messageId || null;

  return (
    <div
      data-agentree-node-hover-card="true"
      className="flex w-[min(920px,var(--radix-hover-card-content-available-width),calc(100vw-2rem))] max-w-[min(920px,var(--radix-hover-card-content-available-width),calc(100vw-2rem))] flex-col overflow-hidden rounded-[24px] border border-border/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.99),rgba(248,250,252,0.95))] p-3 shadow-[0_28px_80px_-36px_rgba(15,23,42,0.38),0_10px_24px_-18px_rgba(15,23,42,0.28)] ring-1 ring-black/5 dark:bg-[linear-gradient(180deg,rgba(10,15,25,0.99),rgba(12,18,28,0.95))] dark:ring-white/10"
    >
      <div
        className="max-h-[calc(min(70vh,720px)-1.5rem)] w-full overflow-y-auto overscroll-contain"
        onWheelCapture={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="min-w-0">
          <div className="min-w-0 rounded-[20px] bg-background/55 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.24)] dark:bg-white/[0.03]">
            <ChatNodeDispatcher
              entityId={entity.entityId}
              projection={projection}
              focusedMessageId={null}
              isSelected={false}
              selectedMessageIdsSet={EMPTY_SELECTED_MESSAGE_IDS}
              onFocus={() => {}}
              onSelect={() => {}}
              onContextMenu={() => {}}
            />
          </div>
        </div>
      </div>
      {replyParentId && (
        <div className="mt-3 flex justify-end border-t border-border/60 pt-3">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5 rounded-lg px-3 text-xs font-medium"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openFloatingChatInput(replyParentId);
            }}
          >
            <Reply className="h-3.5 w-3.5" />
            Reply
          </Button>
        </div>
      )}
    </div>
  );
}
