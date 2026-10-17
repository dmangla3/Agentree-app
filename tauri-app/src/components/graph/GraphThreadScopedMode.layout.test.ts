import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GraphView thread scoped mode wiring', () => {
  const readGraphViewSource = () => readFileSync(join(process.cwd(), 'src/components/GraphView.tsx'), 'utf8');

  it('uses active thread scope before graph computation and layout', () => {
    const source = readGraphViewSource();

    expect(source).toContain('readGraphThreadState(selectedWorkspaceId');
    expect(source).toContain('activeThreadRootId');
    expect(source).toContain('resolveThreadGraphScope({');
    expect(source).toContain('const scopedGraphMessages = threadGraphScope.scopedMessages;');
    expect(source).toContain('const scopedSummaries = filterSummariesForThreadScope(summaries as Summary[], threadGraphScope);');
    expect(source).toContain('filterCommitContextForThreadScope({');
    expect(source).toContain('applySubgraphThreadConversions({');
    expect(source).toContain('messages: graphProjectionMessages,');
    expect(source).toContain('commits: visibleSnapshotCommits,');
    expect(source).toMatch(
      /const workspaceProjection = useWorkspaceProjection\(\s*graphProjectionMessages,\s*scopedSummaries,/,
    );
    expect(source).toContain('messages: graphComputationMessages');
    expect(source).toContain('hiddenThreadRootIdsForLayout');
    expect(source).toContain('onOpenThread: handleFocusThread');
    expect(source).toContain('onConvertSubgraphToThread={handleConvertSubgraphToThread}');
  });

  it('selects a thread instead of hiding other threads when a thread tab is clicked', () => {
    const source = readGraphViewSource();

    expect(source).toContain('setActiveThreadRootId(threadRootId);');
    expect(source).not.toContain("toast.success('Thread hidden'");
  });

  it('does not render thread divider bands in thread-scoped graph mode', () => {
    const source = readGraphViewSource();

    expect(source).toContain('const shouldShowThreadBands = !threadGraphScope.isThreadScoped && !activeGraphRenderHold;');
    expect(source).toContain('if (!shouldShowThreadBands) return [];');
    expect(source).toContain('threadRootIdByMessageId={threadGraphScope.isThreadScoped ? new Map() : threadRootIndex.threadRootIdByMessageId}');
  });

  it('limits chronological hovercard navigation to the visible graph scope', () => {
    const source = readGraphViewSource();

    expect(source).toContain('messages: visibleGraphMessages as Message[]');
    expect(source).toContain('summaries: scopedSummaries as Summary[]');
  });

  it('counts agents from the visible thread instead of the entire workspace', () => {
    const source = readGraphViewSource();

    expect(source).toContain('messages={scopedGraphMessages as Message[]}');
    expect(source).not.toContain('messages={graphMessages as Message[]}');
  });
});
