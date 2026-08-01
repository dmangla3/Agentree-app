import { useMemo, useRef } from 'react';
import type { Message, Scope, Summary } from '../stores/workspaceStore';
import { buildWorkspaceProjection } from '../domain/workspaceProjection';
import { recordFundamentalCounter } from '../perf/fundamentalCounters';

export function useWorkspaceProjection(
  messages: Message[],
  scopes: Scope[],
  summaries: Summary[],
  focusedMessageId: string | null,
  disabledSummaryIds: Set<string> = new Set(),
  surface = 'unknown'
) {
  const previousRef = useRef<{
    messages: Message[];
    scopes: Scope[];
    summaries: Summary[];
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
        focusedMessageId,
        disabledSummaryIds,
      });
      recordFundamentalCounter('workspace.projection', {
        surface,
        messageCount: messages.length,
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
        disabledSummaryIds,
        focusedMessageId,
      };
      return projection;
    })()
  ), [disabledSummaryIds, focusedMessageId, messages, scopes, summaries, surface]);
}
