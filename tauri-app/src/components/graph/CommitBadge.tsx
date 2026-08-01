import { memo, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../lib/utils';
import type { Message, Workspace } from '../../stores/workspaceStore';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useCurrentHead } from '../../hooks/useCurrentHead';
import { useReducedMotion, DURATION } from '../../lib/animation';
import {
  GitCommit,
  ChevronDown,
  ChevronUp,
  User,
  Bot,
  Clock3,
} from 'lucide-react';
import { CopyCommitShaButton } from '../CopyCommitShaButton';
import { getMessageOutputCommitSha } from '../../lib/graph/commitAccessors';

interface CommitBadgeProps {
  commits: Message[];
  maxVisible?: number;
}

const CommitBadge = memo(({ commits, maxVisible = 2 }: CommitBadgeProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const reducedMotion = useReducedMotion();

  const { data: workspacesData } = useWorkspaces();
  const workspaceId = commits[0]?.workspaceId;
  const repoPath = useMemo(() => {
    if (!workspaceId) return null;
    const workspace = workspacesData?.find((conv: Workspace) => conv.id === workspaceId);
    return workspace?.git_repo_path ?? workspace?.folderPath ?? null;
  }, [workspacesData, workspaceId]);

  const { data: currentHeadSha } = useCurrentHead(repoPath);

  if (commits.length === 0) return null;

  const visibleCommits = isExpanded ? commits : commits.slice(0, maxVisible);
  const hasMore = commits.length > maxVisible;

  return (
    <div className="flex flex-col gap-1">
      <AnimatePresence>
        {visibleCommits.map((commit, index) => {
          const executionData = commit.execution_data as Record<string, unknown> | undefined;
          const meta = executionData?.meta as Record<string, unknown> | undefined;
          const isExternal = meta?.sync_source === 'external_git';
          const commitSha = getMessageOutputCommitSha(commit) ?? commit.id.slice(0, 7);
          const subject = commit.aiLabel ||
            (commit.content?.slice(0, 40) + (commit.content && commit.content.length > 40 ? '...' : '')) ||
            'No message';
          const authorName = (meta?.git_author_name as string) || (isExternal ? 'External' : 'Agent');
          const authoredAt =
            (typeof meta?.git_authored_at === 'string' && meta.git_authored_at)
            || commit.createdAt
            || null;

          return (
            <motion.div
              key={commit.id}
              initial={{ opacity: 0, height: reducedMotion ? 'auto' : 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: reducedMotion ? 'auto' : 0 }}
              transition={reducedMotion 
                ? { duration: DURATION.fast } 
                : { duration: DURATION.normal, delay: index * 0.05 }
              }
              className={cn(
                'rounded-md border px-2 py-1.5 text-xs shadow-sm transition-colors',
                isExternal
                  ? 'border-emerald-200 bg-white hover:bg-emerald-50/40'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              )}
            >
              <div className="flex items-center gap-2">
                {currentHeadSha && commitSha === currentHeadSha && (
                  <div className="bg-emerald-500 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm shadow-sm shadow-emerald-500/20 flex-shrink-0" title="Checked Out Commit">
                    HEAD
                  </div>
                )}
                <GitCommit className={cn(
                  'w-3.5 h-3.5 flex-shrink-0',
                  isExternal ? 'text-emerald-600' : 'text-sky-600'
                )} />

                <span className="flex-1 truncate font-medium text-gray-800" title={subject}>
                  {subject}
                </span>

                <code className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[10px] font-mono text-gray-600">
                  {commitSha.slice(0, 8)}
                  <CopyCommitShaButton commitSha={commitSha} className="ml-0.5 inline-flex h-3.5 w-3.5 align-middle" />
                </code>
              </div>

              <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-500">
                <span className="inline-flex items-center gap-1">
                  {isExternal ? (
                    <User className="w-3 h-3" />
                  ) : (
                    <Bot className="w-3 h-3" />
                  )}
                  {authorName}
                </span>
                {authoredAt ? (
                  <span className="inline-flex items-center gap-1 truncate">
                    <Clock3 className="w-3 h-3" />
                    {new Date(authoredAt).toLocaleString()}
                  </span>
                ) : null}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {hasMore && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={cn(
            'flex items-center justify-center gap-1 py-1 text-[10px] text-gray-500',
            'hover:text-gray-700 transition-colors'
          )}
        >
          {isExpanded ? (
            <>
              <ChevronUp className="w-3 h-3" />
              <span>Show less</span>
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3" />
              <span>+{commits.length - maxVisible} more</span>
            </>
          )}
        </button>
      )}
    </div>
  );
});

CommitBadge.displayName = 'CommitBadge';

export { CommitBadge };
