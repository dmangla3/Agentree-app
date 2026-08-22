import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT, GRAPH_COMPOSER_DOCK_EXPAND_EVENT } from '../lib/graphComposerDockEvents';

const readSource = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('graph composer dock graph events', () => {
  it('uses shared graph composer dock event names', () => {
    expect(GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT).toBe('agentree:graph-composer-dock-collapse');
    expect(GRAPH_COMPOSER_DOCK_EXPAND_EVENT).toBe('agentree:graph-composer-dock-expand');
  });

  it('collapses the graph composer when graph viewport movement starts', () => {
    const graphViewSource = readSource('src/components/GraphView.tsx');

    expect(graphViewSource).toContain('dispatchGraphComposerDockCollapse();');
    expect(graphViewSource).toContain('onMoveStart={(event, viewport) => {');
  });

  it('expands the graph composer when a conversation node is clicked', () => {
    const dispatcherSource = readSource('src/components/nodes/graph/GraphNodeDispatcher.tsx');

    expect(dispatcherSource).toContain('dispatchGraphComposerDockExpand();');
    expect(dispatcherSource).toContain("data.entity.kind === 'user_message' || data.entity.kind === 'assistant_message'");
  });

  it('routes user-message edit events into the graph dock composer', () => {
    const composerSource = readSource('src/composer/GraphDockComposer.tsx');

    expect(composerSource).toContain("window.addEventListener('editUserMessage'");
    expect(composerSource).toContain('setEditDraftSource(sourceMessage)');
    expect(composerSource).toContain('setComposerDraft(selectedWorkspaceId, sourceMessage.content || \'\')');
    expect(composerSource).toContain('dispatchGraphComposerDockExpand();');
  });

  it('targets clicked thread origins as root-level composer sends', () => {
    const dispatcherSource = readSource('src/components/nodes/graph/GraphNodeDispatcher.tsx');

    expect(dispatcherSource).toContain("data.entity?.kind === 'thread_origin'");
    expect(dispatcherSource).toContain('setThreadComposerTarget({');
    expect(dispatcherSource).toContain("reason: 'thread-origin'");
  });

  it('opens the graph composer in new-thread mode when the active thread has no messages', () => {
    const graphViewSource = readSource('src/components/GraphView.tsx');

    expect(graphViewSource).toContain('activeEmptyThreadComposerKeyRef');
    expect(graphViewSource).toContain('threadGraphScope.scopedMessageIds.size > 0');
    expect(graphViewSource).toContain('dispatchGraphComposerDockExpand();');
    expect(graphViewSource).toContain('setThreadComposerTarget({');
    expect(graphViewSource).toContain("reason: 'empty-thread'");
  });

  it('opens the graph composer against a clicked thread origin without focusing a child message', () => {
    const graphViewSource = readSource('src/components/GraphView.tsx');

    expect(graphViewSource).toContain("node.type === 'thread_origin'");
    expect(graphViewSource).toContain("reason: 'thread-origin'");
    expect(graphViewSource).toContain('threadId: threadRootId');
    expect(graphViewSource).toContain('dispatchGraphComposerDockExpand();');
  });
});
