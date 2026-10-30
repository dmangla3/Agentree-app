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
});
