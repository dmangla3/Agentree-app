import { useMemo, useRef } from 'react';
import type { CommitEntity, CommitObservationEntity, CommitParentEntity, Message, Scope, Summary } from '../stores/workspaceStore';
import { buildWorkspaceProjection } from '../domain/workspaceProjection';
import { recordFundamentalCounter } from '../perf/fundamentalCounters';

export function useWorkspaceProjection(
  messages: Message[],
  scopes: Scope[],
  summaries: Summary[],
  focusedMessageId: string | null,
  disabledSummaryIds: Set<string> = new Set(),
  surface = 'unknown',
  commits: CommitEntity[] = [],
  commitParents: CommitParentEntity[] = [],
  commitObservations: CommitObservationEntity[] = [],
) {
  const previousRef = useRef<{
    messages: Message[];
    scopes: Scope[];
    summaries: Summary[];
    commits: CommitEntity[];
    commitParents: CommitParentEntity[];
    commitObservations: CommitObservationEntity[];
    disabledSummaryIds: Set<string>;
    focusedMessageId: string | null;
  } | null>(null);

  return useMemo(() => (
    (() => {
      const previous = previousRef.current;
      const startedAt = performance.now();
      const projection = buildWorkspaceProjection({
        messages,
        scopes,
        summaries,
        commits,
        commitParents,
        commitObservations,
        focusedMessageId,
        disabledSummaryIds,
      });
      recordFundamentalCounter('workspace.projection', {
        surface,
        messageCount: messages.length,
        commitCount: commits.length,
        scopeCount: scopes.length,
        summaryCount: summaries.length,
        chatItemCount: projection.chatItems.length,
        entityCount: projection.entities.length,
        disabledSummaryCount: disabledSummaryIds.size,
        focusedMessageId,
        reasons: previous
          ? [
              previous.messages !== messages ? 'messages-ref' : null,
              previous.scopes !== scopes ? 'scopes-ref' : null,
              previous.summaries !== summaries ? 'summaries-ref' : null,
              previous.commits !== commits ? 'commits-ref' : null,
              previous.commitParents !== commitParents ? 'commit-parents-ref' : null,
              previous.commitObservations !== commitObservations ? 'commit-observations-ref' : null,
              previous.disabledSummaryIds !== disabledSummaryIds ? 'disabled-summaries-ref' : null,
              previous.focusedMessageId !== focusedMessageId ? 'focus' : null,
              previous.messages.length !== messages.length ? 'message-count' : null,
              previous.summaries.length !== summaries.length ? 'summary-count' : null,
            ].filter((reason): reason is string => Boolean(reason))
          : ['initial'],
      }, performance.now() - startedAt);
      previousRef.current = {
        messages,
        scopes,
        summaries,
        commits,
        commitParents,
        commitObservations,
        disabledSummaryIds,
        focusedMessageId,
      };
      return projection;
    })()
  ), [commitObservations, commitParents, commits, disabledSummaryIds, focusedMessageId, messages, scopes, summaries, surface]);
}
