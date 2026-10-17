// @vitest-environment jsdom
import '../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvancedSearchPanel, HighlightedSearchText } from './AdvancedSearchPanel';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: apiMock }));
vi.mock('../hooks/useModels', () => ({ useModels: () => ({ data: [] }) }));
vi.mock('../hooks/useWorkspaces', () => ({ useWorkspaces: () => ({ data: [] }) }));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: { selectedWorkspaceId: null }) => unknown) => (
    selector({ selectedWorkspaceId: null })
  ),
}));
vi.mock('../hotkeys/searchHotkeys', () => ({ useCloseSearchHotkey: vi.fn() }));
vi.mock('../lib/agentreeDeepLinks', () => ({ copyAgentreeLink: vi.fn() }));

describe('HighlightedSearchText', () => {
  it('renders message HTML as inert text', () => {
    const content = '<img src=x onerror="window.__searchXss = true"> Agentree result';
    const { container } = render(
      <HighlightedSearchText content={content} searchQuery="Agentree" />
    );

    expect(container.textContent).toBe(content);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('mark')?.textContent).toBe('Agentree');
  });

  it('treats regex metacharacters in query terms as literal text', () => {
    const { container } = render(
      <HighlightedSearchText
        content="v1x2x3 is different from v1.2.3"
        searchQuery="v1.2.3"
      />
    );

    expect(Array.from(container.querySelectorAll('mark')).map(mark => mark.textContent))
      .toEqual(['v1.2.3']);
  });

  it('highlights ordinary search terms case-insensitively', () => {
    const { container } = render(
      <HighlightedSearchText
        content="Agentree keeps AGENTREE searchable"
        searchQuery="agentree"
      />
    );

    expect(Array.from(container.querySelectorAll('mark')).map(mark => mark.textContent))
      .toEqual(['Agentree', 'AGENTREE']);
  });
});

describe('AdvancedSearchPanel', () => {
  beforeEach(() => {
    apiMock.get.mockResolvedValue({
      data: { suggestions: ['Agentree architecture'] },
    });
    apiMock.post.mockResolvedValue({ data: { results: [] } });
  });

  it('searches the selected suggestion instead of the previous input value', async () => {
    render(<AdvancedSearchPanel isOpen onClose={vi.fn()} />);

    fireEvent.change(
      screen.getByPlaceholderText('Search workspaces with natural language...'),
      { target: { value: 'agent' } },
    );

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith('/search/suggestions', {
        params: { q: 'agent' },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Agentree architecture' }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/search', expect.objectContaining({
        query: 'Agentree architecture',
      }));
    });
    expect(apiMock.post).toHaveBeenCalledTimes(1);
  });
});
