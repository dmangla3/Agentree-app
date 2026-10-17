// @vitest-environment jsdom
import '../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GraphComposerDock } from './GraphComposerDock';
import { GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT, GRAPH_COMPOSER_DOCK_EXPAND_EVENT } from '../lib/graphComposerDockEvents';

vi.mock('../composer/GraphDockComposer', () => ({
  GraphDockComposer: () => (
    <div data-testid="mock-graph-dock-composer">
      <input aria-label="Mock graph composer prompt" data-testid="mock-graph-dock-composer-input" defaultValue="" />
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

    expect(screen.getByTestId('graph-composer-dock').hasAttribute('hidden')).toBe(true);
    expect(screen.getByTestId('graph-composer-dock-pill')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Expand graph composer' }));

    expect(screen.getByTestId('graph-composer-dock').hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('mock-graph-dock-composer')).toBeTruthy();
  });

  it('preserves graph composer draft while collapsed', async () => {
    const user = userEvent.setup();

    render(<GraphComposerDock isVisible={true} />);
    await user.type(screen.getByLabelText('Mock graph composer prompt'), 'keep this draft');

    await user.click(screen.getByRole('button', { name: 'Collapse graph composer' }));
    await user.click(screen.getByRole('button', { name: 'Expand graph composer' }));

    expect((screen.getByLabelText('Mock graph composer prompt') as HTMLInputElement).value).toBe('keep this draft');
  });

  it('collapses on graph movement and expands on conversation node focus events', async () => {
    render(<GraphComposerDock isVisible={true} />);

    window.dispatchEvent(new Event(GRAPH_COMPOSER_DOCK_COLLAPSE_EVENT));

    await waitFor(() => expect(screen.getByTestId('graph-composer-dock').hasAttribute('hidden')).toBe(true));
    expect(screen.getByTestId('graph-composer-dock-pill')).toBeTruthy();

    window.dispatchEvent(new Event(GRAPH_COMPOSER_DOCK_EXPAND_EVENT));

    await waitFor(() => expect(screen.getByTestId('graph-composer-dock').hasAttribute('hidden')).toBe(false));
    expect(screen.getByTestId('mock-graph-dock-composer')).toBeTruthy();
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

  it('uses a bounded autosizing textarea for long graph composer prompts', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(composerSource).toContain("import { TemplateMentionTextarea } from '../components/composer/TemplateMentionTextarea';");
    expect(composerSource).toContain('<TemplateMentionTextarea');
    expect(composerSource).toContain('minRows={2}');
    expect(composerSource).toContain('maxRows={10}');
    expect(composerSource).toContain('overflow-y-auto');
    expect(composerSource).not.toContain('<textarea');
  });

  it('keeps model selection in the footer and code base, context, and permissions in the control row', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(composerSource).not.toContain('aria-label="Select flow"');
    expect(composerSource).not.toContain('aria-label="Select model"');
    expect(composerSource).toContain('aria-label={`Change ${chipAgent.name}`}');
    expect(composerSource).toContain('aria-label="Add model"');
    expect(composerSource).toContain('aria-label="Select code base commit"');
    expect(composerSource).toContain('aria-label="Select context"');
    expect(composerSource).toContain('aria-label="Select permissions"');
    expect(composerSource).not.toContain(['useAgent', 'FlowRunner'].join(''));
    expect(composerSource).toContain('UnifiedAgentModelSelector');
  });

  it('keeps tracked-ref code-base chips and model run counts wired in graph composer', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(composerSource).toContain('useTrackedRefs');
    expect(composerSource).toContain('useGitRefSnapshot');
    expect(composerSource).toContain('const liveGitRefs = useMemo(() => buildLiveGitRefs({');
    expect(composerSource).toContain('refs: liveRefs');
    expect(composerSource).toContain('trackedRefs: liveTrackedRefs');
    expect(composerSource).toContain('headSha: currentHeadSha');
    expect(composerSource).toContain('agentRunCounts=');
    expect(composerSource).not.toContain('onAgentRunCountChange=');
    expect(composerSource).toContain("modelPickerTarget?.kind === 'replace'");
    expect(composerSource).toContain("modelPickerTarget?.kind === 'add' ? Object.keys(normalizedSelectedAgentRunCounts) : undefined");
    expect(composerSource).toContain('selectedAgentRunChips.map');
    expect(composerSource).not.toContain('selectedAgentRunChips.slice');
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

    expect(composerSource).toContain('const footerStatusText = error ?? (');
    expect(composerSource).toContain('pendingOrchestration');
    expect(composerSource).toContain('child runs planned');
    expect(composerSource).not.toContain("selectedFlow ? `${selectedFlow.label} · ${flowParallelCount} parallel runs` : modelSelectorLabel");
  });

  it('handles explicit thread composer targets inside the graph dock composer', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const composerSource = readFileSync(join(process.cwd(), 'src/composer/GraphDockComposer.tsx'), 'utf8');

    expect(composerSource).not.toContain('agentree:startNewThread');
    expect(composerSource).toContain('threadComposerTarget');
    expect(composerSource).toContain("type ComposerTargetMode = 'reply' | 'new-thread';");
    expect(composerSource).toContain("setComposerTargetMode('new-thread');");
    expect(composerSource).toContain('setPendingThreadId(threadComposerTarget.threadId)');
    expect(composerSource).toContain('createThreadSession.mutateAsync');
    expect(composerSource).toContain("setContextPolicy('fresh');");
    expect(composerSource).toContain("setComposerTargetMode('reply');");
  });
});
