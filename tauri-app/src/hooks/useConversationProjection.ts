import { useMemo, useRef } from 'react';
import type { CommitEntity, CommitObservationEntity, CommitParentEntity, Message, Summary } from '../stores/workspaceStore';
import { buildWorkspaceProjection, type EmptyThreadRootInput } from '../domain/workspaceProjection';
import type { ThreadSession } from '../lib/threadSessions';
import { recordFundamentalCounter } from '../perf/fundamentalCounters';

export function useWorkspaceProjection(
  messages: Message[],
  summaries: Summary[],
  focusedMessageId: string | null,
  disabledSummaryIds: Set<string> = new Set(),
  surface = 'unknown',
  commits: CommitEntity[] = [],
  commitParents: CommitParentEntity[] = [],
  commitObservations: CommitObservationEntity[] = [],
  emptyThreadRoot: EmptyThreadRootInput | null = null,
  syntheticThreadRoots: EmptyThreadRootInput[] = [],
  threadSessions: ThreadSession[] = [],
) {
  const previousRef = useRef<{
    messages: Message[];
    summaries: Summary[];
    commits: CommitEntity[];
    commitParents: CommitParentEntity[];
    commitObservations: CommitObservationEntity[];
    disabledSummaryIds: Set<string>;
    focusedMessageId: string | null;
    emptyThreadRoot: EmptyThreadRootInput | null;
    syntheticThreadRoots: EmptyThreadRootInput[];
    threadSessions: ThreadSession[];
  } | null>(null);

  return useMemo(() => (
    (() => {
      const previous = previousRef.current;
      const startedAt = performance.now();
      const projection = buildWorkspaceProjection({
        messages,
        summaries,
        commits,
        commitParents,
        commitObservations,
        focusedMessageId,
        disabledSummaryIds,
        emptyThreadRoot,
        syntheticThreadRoots,
        threadSessions,
      });
      recordFundamentalCounter('workspace.projection', {
        surface,
        messageCount: messages.length,
        commitCount: commits.length,
        summaryCount: summaries.length,
        chatItemCount: projection.chatItems.length,
        entityCount: projection.entities.length,
        disabledSummaryCount: disabledSummaryIds.size,
        focusedMessageId,
        reasons: previous
          ? [
              previous.messages !== messages ? 'messages-ref' : null,
              previous.summaries !== summaries ? 'summaries-ref' : null,
              previous.commits !== commits ? 'commits-ref' : null,
              previous.commitParents !== commitParents ? 'commit-parents-ref' : null,
              previous.commitObservations !== commitObservations ? 'commit-observations-ref' : null,
              previous.disabledSummaryIds !== disabledSummaryIds ? 'disabled-summaries-ref' : null,
              previous.focusedMessageId !== focusedMessageId ? 'focus' : null,
              previous.emptyThreadRoot !== emptyThreadRoot ? 'empty-thread-root-ref' : null,
              previous.syntheticThreadRoots !== syntheticThreadRoots ? 'synthetic-thread-roots-ref' : null,
              previous.threadSessions !== threadSessions ? 'thread-sessions-ref' : null,
              previous.messages.length !== messages.length ? 'message-count' : null,
              previous.summaries.length !== summaries.length ? 'summary-count' : null,
            ].filter((reason): reason is string => Boolean(reason))
          : ['initial'],
      }, performance.now() - startedAt);
      previousRef.current = {
        messages,
        summaries,
        commits,
        commitParents,
        commitObservations,
        disabledSummaryIds,
        focusedMessageId,
        emptyThreadRoot,
        syntheticThreadRoots,
        threadSessions,
      };
      return projection;
    })()
  ), [commitObservations, commitParents, commits, disabledSummaryIds, emptyThreadRoot, focusedMessageId, messages, summaries, surface, syntheticThreadRoots, threadSessions]);
}
