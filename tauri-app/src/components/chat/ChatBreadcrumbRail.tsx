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
          'text-cyan-800 hover:border-cyan-300/70 hover:bg-cyan-50/90 dark:text-cyan-200 dark:hover:border-cyan-800'
        ),
        focusedClassName: 'border-cyan-400/70 bg-cyan-100 text-cyan-950 shadow-[0_8px_24px_rgba(8,145,178,0.14)] dark:border-cyan-500/70 dark:bg-cyan-950/55 dark:text-cyan-50',
        iconClassName: 'border-cyan-200/80 bg-white text-cyan-600 dark:border-cyan-800 dark:bg-slate-950/80 dark:text-cyan-300',
        labelClassName: 'text-cyan-800 dark:text-cyan-100',
      };
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
