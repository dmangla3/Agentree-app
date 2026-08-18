// @vitest-environment jsdom
import '../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GraphComposerDock } from './GraphComposerDock';
import { GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT, GRAPH_COMPOSER_DOCK_EXPAND_EVENT } from '../lib/graphComposerDockEvents';

vi.mock('../composer/GraphDockComposer', () => ({
  GraphDockComposer: () => (
    <div
      data-testid="mock-graph-dock-composer"
    >
      composer
    </div>
  ),
}));

describe('GraphComposerDock', () => {
  it('does not render when chat is visible', () => {
    render(<GraphComposerDock isVisible={false} />);

    expect(screen.queryByTestId('graph-composer-dock')).toBeNull();
  });

  it('renders the lightweight graph dock composer when chat is hidden', () => {
    render(<GraphComposerDock isVisible={true} />);

    expect(screen.getByTestId('graph-composer-dock')).toBeTruthy();
    expect(screen.getByTestId('mock-graph-dock-composer')).toBeTruthy();
  });

  it('collapses to a small pill and expands from the pill', async () => {
    const user = userEvent.setup();

    render(<GraphComposerDock isVisible={true} />);
    await user.click(screen.getByRole('button', { name: 'Collapse graph composer' }));

    expect(screen.queryByTestId('mock-graph-dock-composer')).toBeNull();
    expect(screen.getByTestId('graph-composer-dock-pill')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Expand graph composer' }));

    expect(screen.getByTestId('mock-graph-dock-composer')).toBeTruthy();
  });

  it('collapses on graph movement and expands on conversation node focus events', async () => {
    render(<GraphComposerDock isVisible={true} />);

    window.dispatchEvent(new Event(GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT));

    await waitFor(() => expect(screen.queryByTestId('mock-graph-dock-composer')).toBeNull());
    expect(screen.getByTestId('graph-composer-dock-pill')).toBeTruthy();

    window.dispatchEvent(new Event(GRAPH_COMPOSER_DOCK_EXPAND_EVENT));

    await waitFor(() => expect(screen.getByTestId('mock-graph-dock-composer')).toBeTruthy());
  });

  it('does not import the legacy ChatInput implementation', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dockSource = readFileSync(join(process.cwd(), 'src/components/GraphComposerDock.tsx'), 'utf8');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(dockSource).toContain("import { GraphDockComposer } from '../composer/GraphDockComposer';");
    expect(dockSource).not.toContain("import { ChatInput } from './ChatInput';");
    expect(composerSource).not.toContain('ChatInput');
    expect(composerSource).not.toContain('useWorkspaceMessages');
  });

  it('keeps the graph composer control surface for flow, model, code base, and context', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(composerSource).toContain('aria-label="Select flow"');
    expect(composerSource).toContain('aria-label="Select model"');
    expect(composerSource).toContain('aria-label="Select code base commit"');
    expect(composerSource).toContain('aria-label="Select context"');
    expect(composerSource).toContain('useAgentFlowRunner');
    expect(composerSource).toContain('UnifiedAgentModelSelector');
  });

  it('keeps tracked-ref code-base chips and multi-model selection wired in graph composer', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(composerSource).toContain('useTrackedRefs');
    expect(composerSource).toContain('useGitRefSnapshot');
    expect(composerSource).toContain('trackedRefs: trackedRefsQuery.data ?? []');
    expect(composerSource).toContain('headSha: currentHeadSha');
    expect(composerSource).toContain('agentRunCounts=');
    expect(composerSource).toContain('onAgentRunCountChange=');
    expect(composerSource).toContain('buildComposerAgentRuns');
  });

  it('renders selected model chips in the footer row instead of the main control row', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    const controlRowIndex = composerSource.indexOf('data-testid="graph-dock-control-row"');
    const chipRowIndex = composerSource.indexOf('data-testid="graph-dock-selected-model-chips"');
    const sendButtonIndex = composerSource.indexOf('data-testid="graph-dock-send-button"');

    expect(controlRowIndex).toBeGreaterThan(-1);
    expect(chipRowIndex).toBeGreaterThan(controlRowIndex);
    expect(chipRowIndex).toBeLessThan(sendButtonIndex);
  });

  it('does not duplicate the selected model label in the footer status text', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(composerSource).toContain('const footerStatusText = error ?? (isSteeringRunningAssistant ?');
    expect(composerSource).not.toContain("selectedFlow ? `${selectedFlow.label} · ${flowParallelCount} parallel runs` : modelSelectorLabel");
  });

  it('does not keep an internal new-thread mode in the graph dock composer', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(composerSource).not.toContain('agentree:startNewThread');
    expect(composerSource).not.toContain('setTargetMode');
    expect(composerSource).not.toContain("'new-thread'");
    expect(composerSource).toContain('Reply');
  });
});
