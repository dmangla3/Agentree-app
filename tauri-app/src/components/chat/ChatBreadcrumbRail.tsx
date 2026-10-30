import { Bot, GitBranch, GitCommitHorizontal, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ProjectedNodeEntity, WorkspaceProjection } from '../../domain/workspaceProjection';
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

const bySortTs = (left: ProjectedNodeEntity, right: ProjectedNodeEntity) =>
  left.sortTs - right.sortTs;

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
    case 'thread_link':
      return {
        icon: GitBranch,
        typeLabel: 'Thread',
        idleClassName: cn(
          ROLE_COLORS.thread_link.bg,
          ROLE_COLORS.thread_link.border,
          'text-foreground/80 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-panel-strong)/0.72)]'
        ),
        focusedClassName: 'border-[hsl(var(--app-accent)/0.38)] bg-[hsl(var(--app-accent-soft)/0.68)] text-foreground shadow-[0_10px_24px_-20px_hsl(var(--app-accent)/0.34)]',
        iconClassName: 'border-cyan-300/60 bg-[hsl(var(--app-panel))] text-cyan-600 dark:border-white/10 dark:text-zinc-300',
        labelClassName: 'text-foreground/85',
      };
    case 'user_message':
      return {
        icon: UserRound,
        typeLabel: 'User',
        idleClassName: cn(
          ROLE_COLORS.user_message.bg,
          ROLE_COLORS.user_message.border,
          'text-foreground/80 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-panel-strong)/0.72)]'
        ),
        focusedClassName: 'border-[hsl(var(--app-accent)/0.38)] bg-[hsl(var(--app-accent-soft)/0.68)] text-foreground shadow-[0_10px_24px_-20px_hsl(var(--app-accent)/0.34)]',
        iconClassName: 'border-[hsl(var(--app-border)/0.62)] bg-[hsl(var(--app-panel))] text-muted-foreground',
        labelClassName: 'text-foreground/85',
      };
    case 'commit_message':
      return {
        icon: GitCommitHorizontal,
        typeLabel: 'Commit',
        idleClassName: cn(
          ROLE_COLORS.commit_message.bg,
          ROLE_COLORS.commit_message.border,
          'text-foreground/80 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-panel-strong)/0.72)]'
        ),
        focusedClassName: 'border-[hsl(var(--app-accent)/0.38)] bg-[hsl(var(--app-accent-soft)/0.68)] text-foreground shadow-[0_10px_24px_-20px_hsl(var(--app-accent)/0.34)]',
        iconClassName: 'border-emerald-300/60 bg-[hsl(var(--app-panel))] text-emerald-600 dark:border-emerald-800 dark:text-emerald-300',
        labelClassName: 'text-foreground/85',
      };
    case 'assistant_message':
    default:
      return {
        icon: Bot,
        typeLabel: 'Assistant',
        idleClassName: cn(
          ROLE_COLORS.assistant_message.bg,
          ROLE_COLORS.assistant_message.border,
          'text-foreground/80 hover:border-[hsl(var(--app-border-strong)/0.68)] hover:bg-[hsl(var(--app-panel-strong)/0.72)]'
        ),
        focusedClassName: 'border-[hsl(var(--app-accent)/0.38)] bg-[hsl(var(--app-accent-soft)/0.68)] text-foreground shadow-[0_10px_24px_-20px_hsl(var(--app-accent)/0.34)]',
        iconClassName: 'border-blue-300/60 bg-[hsl(var(--app-panel))] text-[hsl(var(--app-accent))] dark:border-white/10',
        labelClassName: 'text-foreground/85',
      };
  }
};

function EntityNavigationRail({
  ariaLabel,
  label,
  projection,
  entities,
  focusedMessageId,
  onFocus,
  showPathSeparators = false,
}: {
  ariaLabel: string;
  label: string;
  projection: WorkspaceProjection;
  entities: ProjectedNodeEntity[];
  focusedMessageId: string | null;
  onFocus: (messageId: string) => void;
  showPathSeparators?: boolean;
}) {
  const [activeEntityId, setActiveEntityId] = useState<string | null>(null);

  if (!focusedMessageId || entities.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label={ariaLabel}
      className="flex items-start gap-2 border-b border-[hsl(var(--app-border)/0.52)] bg-[hsl(var(--app-panel)/0.9)] px-4 py-1.5"
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
                        'group flex min-h-10 max-w-[220px] items-center gap-1.5 rounded-lg border px-2 text-[10px] font-medium leading-none transition-[background-color,border-color,color,box-shadow,transform] duration-normal ease-out-cubic active:scale-[0.96] motion-reduce:transition-none',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                        isFocused
                          ? kindMeta.focusedClassName
                          : kindMeta.idleClassName
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-transform duration-normal ease-out-cubic motion-reduce:transition-none group-hover:scale-105',
                          kindMeta.iconClassName
                        )}
                      >
                        <Icon size={10} strokeWidth={2.1} />
                      </span>
                      {entity.kind === 'commit_message' && entity.shortSha ? (
                        <code className="shrink-0 rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-emerald-700 dark:bg-emerald-400/12 dark:text-emerald-300">
                          {entity.shortSha}
                        </code>
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
