import { Bot, GitCommitHorizontal, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../../domain/workspaceProjection';
import type { Message } from '../../stores/workspaceStore';
import type { AgentStatus } from '@shared/agentStatus';
import { cn } from '../../lib/utils';
import { ROLE_COLORS } from '../../lib/visualTokens';
import { NodeHoverCardContent } from '../NodeHoverCardContent';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '../../../@/components/ui/hover-card';

interface ChatBreadcrumbRailProps {
  projection: WorkspaceProjection;
  focusedMessageId: string | null;
  onFocus: (messageId: string) => void;
}

interface ChatRecentFocusRailProps extends ChatBreadcrumbRailProps {
  recentMessageIds: string[];
}

interface ChatAgentRecencyRailProps extends ChatBreadcrumbRailProps {
  messages: Message[];
}

const bySortTs = (left: ProjectedNodeEntity, right: ProjectedNodeEntity) =>
  left.sortTs - right.sortTs;

const ACTIVE_AGENT_STATUSES = new Set<AgentStatus | string>(['pending', 'running', 'streaming']);
const TERMINAL_AGENT_STATUSES = new Set<AgentStatus | string>(['completed', 'error', 'failed', 'cancelled']);
const MAX_AGENT_RAIL_ITEMS = 24;

const getMessageTime = (message: Message): number => {
  const timestamp = message.last_event_at || message.updatedAt || message.createdAt;
  const parsed = Date.parse(timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const getBreadcrumbLabel = (entity: ProjectedNodeEntity) => {
  const message = entity.message;
  if (!message) return entity.shortLabel;

  if (entity.kind === 'commit_message') {
    const cleaned = (entity.preview || '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length > 0) {
      return cleaned.length > 30 ? `${cleaned.slice(0, 27)}...` : cleaned;
    }

    return entity.shortSha || 'Commit';
  }

  if (message.aiLabel && message.aiLabel.trim()) {
    return message.aiLabel.trim();
  }

  const cleaned = (message.content || '')
    .replace(/```[\s\S]*?```/g, '[Code]')
    .replace(/`[^`]+`/g, '[Code]')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length > 0) {
    return cleaned.length > 36 ? `${cleaned.slice(0, 33)}...` : cleaned;
  }

  if (message.llmModel) {
    const modelLabel = message.llmModel.split('/').pop() || message.llmModel;
    return modelLabel.length > 0 ? modelLabel : 'Assistant';
  }

  return 'Assistant';
};

const getBreadcrumbTitle = (entity: ProjectedNodeEntity) => {
  const message = entity.message;
  if (!message) return entity.shortLabel;

  const label = message.aiLabel?.trim();
  if (label) return label;

  const content = (message.content || '').replace(/\s+/g, ' ').trim();
  if (content) return content;

  return message.llmModel || 'Assistant';
};

const getBreadcrumbKindMeta = (entity: ProjectedNodeEntity) => {
  switch (entity.kind) {
    case 'user_message':
      return {
        icon: UserRound,
        typeLabel: 'User',
        idleClassName: cn(
          ROLE_COLORS.user_message.bg,
          ROLE_COLORS.user_message.border,
          'text-slate-700 hover:border-slate-300 hover:bg-slate-100/90 dark:text-slate-200 dark:hover:border-slate-600'
        ),
        focusedClassName: 'border-slate-400/70 bg-slate-200 text-slate-950 shadow-[0_6px_20px_rgba(15,23,42,0.12)] dark:border-slate-500/70 dark:bg-slate-800 dark:text-slate-50',
        iconClassName: 'border-slate-300/70 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300',
        labelClassName: 'text-slate-700 dark:text-slate-200',
      };
    case 'commit_message':
      return {
        icon: GitCommitHorizontal,
        typeLabel: 'Commit',
        idleClassName: cn(
          ROLE_COLORS.commit_message.bg,
          ROLE_COLORS.commit_message.border,
          'text-emerald-800 hover:border-emerald-300/70 hover:bg-emerald-50/90 dark:text-emerald-200 dark:hover:border-emerald-700'
        ),
        focusedClassName: 'border-emerald-400/70 bg-emerald-100 text-emerald-950 shadow-[0_8px_24px_rgba(16,185,129,0.16)] dark:border-emerald-500/70 dark:bg-emerald-950/50 dark:text-emerald-50',
        iconClassName: 'border-emerald-200/80 bg-emerald-50 text-emerald-600 dark:border-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300',
        labelClassName: 'text-emerald-800 dark:text-emerald-100',
      };
    case 'assistant_message':
    default:
      return {
        icon: Bot,
        typeLabel: 'Assistant',
        idleClassName: cn(
          ROLE_COLORS.assistant_message.bg,
          ROLE_COLORS.assistant_message.border,
          'text-sky-800 hover:border-sky-300/70 hover:bg-sky-50/90 dark:text-sky-200 dark:hover:border-sky-800'
        ),
        focusedClassName: 'border-sky-400/70 bg-sky-100 text-sky-950 shadow-[0_8px_24px_rgba(14,165,233,0.14)] dark:border-sky-500/70 dark:bg-sky-950/55 dark:text-sky-50',
        iconClassName: 'border-sky-200/80 bg-white text-sky-600 dark:border-sky-800 dark:bg-slate-950/80 dark:text-sky-300',
        labelClassName: 'text-sky-800 dark:text-sky-100',
      };
  }
};

const getAgentStatusLabel = (status: AgentStatus | null | undefined) => {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'running':
    case 'streaming':
      return 'Running';
    case 'completed':
      return 'Done';
    case 'error':
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return null;
  }
};

const getAgentStatusClassName = (status: AgentStatus | null | undefined) => {
  if (status && ACTIVE_AGENT_STATUSES.has(status)) {
    return 'bg-amber-500/12 text-amber-700 dark:bg-amber-400/12 dark:text-amber-300';
  }
  if (status === 'completed') {
    return 'bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300';
  }
  if (status === 'error' || status === 'failed') {
    return 'bg-red-500/12 text-red-700 dark:bg-red-400/12 dark:text-red-300';
  }
  if (status === 'cancelled') {
    return 'bg-slate-500/12 text-slate-600 dark:bg-slate-400/12 dark:text-slate-300';
  }
  return 'bg-slate-500/12 text-slate-600 dark:bg-slate-400/12 dark:text-slate-300';
};

function EntityNavigationRail({
  ariaLabel,
  label,
  projection,
  entities,
  focusedMessageId,
  onFocus,
  showPathSeparators = false,
  statusByMessageId,
}: {
  ariaLabel: string;
  label: string;
  projection: WorkspaceProjection;
  entities: ProjectedNodeEntity[];
  focusedMessageId: string | null;
  onFocus: (messageId: string) => void;
  showPathSeparators?: boolean;
  statusByMessageId?: Map<string, AgentStatus | null | undefined>;
}) {
  const [activeEntityId, setActiveEntityId] = useState<string | null>(null);

  if (!focusedMessageId || entities.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label={ariaLabel}
      className="flex items-start gap-2 border-b border-border bg-muted/30 px-4 py-1.5 dark:bg-muted/20"
    >
      <span className="min-w-[3.5rem] shrink-0 pt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="relative min-w-0 flex-1">
        <ol
          className="custom-scrollbar flex items-center gap-1 overflow-x-auto overscroll-x-contain py-0.5 pl-1 pr-2"
          onScroll={() => setActiveEntityId(null)}
          onWheel={() => setActiveEntityId(null)}
          onTouchMove={() => setActiveEntityId(null)}
          onPointerLeave={() => setActiveEntityId(null)}
        >
          {entities.map((entity, index: number) => {
            const message = entity.message;
            if (!message) return null;

            const isFocused = message.id === focusedMessageId;
            const kindMeta = getBreadcrumbKindMeta(entity);
            const Icon = kindMeta.icon;
            const status = statusByMessageId?.get(message.id) ?? null;
            const statusLabel = getAgentStatusLabel(status);

            return (
              <li key={message.id} className="flex flex-shrink-0 items-center gap-1">
                <HoverCard
                  open={activeEntityId === message.id}
                  onOpenChange={(open) => setActiveEntityId(open ? message.id : null)}
                  openDelay={500}
                  closeDelay={100}
                >
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onFocus(message.id)}
                      aria-current={isFocused ? 'page' : undefined}
                      aria-label={`${kindMeta.typeLabel}: ${getBreadcrumbTitle(entity)}`}
                      title={`${kindMeta.typeLabel}: ${getBreadcrumbTitle(entity)}`}
                      className={cn(
                        'group flex max-w-[220px] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out',
                        'shadow-sm hover:-translate-y-[1px]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                        isFocused
                          ? kindMeta.focusedClassName
                          : kindMeta.idleClassName
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border shadow-sm transition-transform duration-200 group-hover:scale-105',
                          kindMeta.iconClassName
                        )}
                      >
                        <Icon size={10} strokeWidth={2.1} />
                      </span>
                      {entity.kind === 'commit_message' && entity.shortSha ? (
                        <code className="shrink-0 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300">
                          {entity.shortSha}
                        </code>
                      ) : null}
                      {statusLabel ? (
                        <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none', getAgentStatusClassName(status))}>
                          {statusLabel}
                        </span>
                      ) : null}
                      <span className={cn('min-w-0 truncate', kindMeta.labelClassName)}>
                        {getBreadcrumbLabel(entity)}
                      </span>
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    className="w-auto border-none bg-transparent p-0 shadow-none"
                  >
                    <NodeHoverCardContent entity={entity} projection={projection} />
                  </HoverCardContent>
                </HoverCard>
                {showPathSeparators && index < entities.length - 1 && (
                  <span aria-hidden="true" className="text-xs text-muted-foreground/60">→</span>
                )}
              </li>
            );
          })}
        </ol>
        <div className="pointer-events-none absolute left-0 top-0 h-full w-6 bg-gradient-to-r from-muted/40 to-transparent" />
        <div className="pointer-events-none absolute right-0 top-0 h-full w-6 bg-gradient-to-l from-muted/40 to-transparent" />
      </div>
    </nav>
  );
}

export function ChatBreadcrumbRail({
  projection,
  focusedMessageId,
  onFocus,
}: ChatBreadcrumbRailProps) {
  const breadcrumbEntities = useMemo(() => (
    projection.entities
      .filter((entity) => (
        !!entity.messageId &&
        projection.branchPathMessageIds.has(entity.messageId)
      ))
      .sort(bySortTs)
  ), [projection]);

  return (
    <EntityNavigationRail
      ariaLabel="Workspace path"
      label="Path"
      projection={projection}
      entities={breadcrumbEntities}
      focusedMessageId={focusedMessageId}
      onFocus={onFocus}
      showPathSeparators
    />
  );
}

export function ChatRecentFocusRail({
  projection,
  focusedMessageId,
  recentMessageIds,
  onFocus,
}: ChatRecentFocusRailProps) {
  const recentEntities = useMemo(() => (
    recentMessageIds
      .map((messageId) => projection.entitiesByMessageId.get(messageId))
      .filter((entity): entity is ProjectedNodeEntity => Boolean(entity?.message))
  ), [projection.entitiesByMessageId, recentMessageIds]);

  return (
    <EntityNavigationRail
      ariaLabel="Recently focused messages"
      label="Recent Focus"
      projection={projection}
      entities={recentEntities}
      focusedMessageId={focusedMessageId}
      onFocus={onFocus}
    />
  );
}

export function ChatAgentRecencyRail({
  projection,
  messages,
  focusedMessageId,
  onFocus,
}: ChatAgentRecencyRailProps) {
  const statusByMessageId = useMemo(() => {
    const map = new Map<string, AgentStatus | null | undefined>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      map.set(message.id, message.status);
    }
    return map;
  }, [messages]);

  const agentEntities = useMemo(() => {
    const candidates: Array<{
      entity: ProjectedNodeEntity;
      status: AgentStatus | null | undefined;
      statusRank: number;
      recency: number;
    }> = [];

    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const status = message.status;
      const hasAgentIdentity = Boolean(message.agent_id || status);
      if (!hasAgentIdentity) continue;
      const isActive = Boolean(status && ACTIVE_AGENT_STATUSES.has(status));
      const isTerminal = Boolean(status && TERMINAL_AGENT_STATUSES.has(status));
      if (!isActive && !isTerminal) continue;
      const entity = projection.entitiesByMessageId.get(message.id);
      if (!entity?.message) continue;

      candidates.push({
        entity,
        status,
        statusRank: isActive ? 0 : 1,
        recency: getMessageTime(message),
      });
    }

    return candidates
      .sort((left, right) => (
        left.statusRank - right.statusRank ||
        right.recency - left.recency ||
        right.entity.sortTs - left.entity.sortTs
      ))
      .slice(0, MAX_AGENT_RAIL_ITEMS)
      .map((candidate) => candidate.entity);
  }, [messages, projection.entitiesByMessageId]);

  return (
    <EntityNavigationRail
      ariaLabel="Agent recency"
      label="Agents - Running | Completed"
      projection={projection}
      entities={agentEntities}
      focusedMessageId={focusedMessageId}
      onFocus={onFocus}
      statusByMessageId={statusByMessageId}
    />
  );
}
