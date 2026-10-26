import { cleanup, fireEvent, render } from '@testing-library/react';
// @ts-expect-error jsdom ships without a project-local declaration in this workspace.
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelVisibilitySettingsPanel } from './ModelVisibilitySettingsPanel';

const agents = [
  {
    id: 'opencode:new-vision',
    type: 'opencode',
    name: 'New Vision',
    model_config: {
      model: 'provider/new-vision',
      modelProvider: 'provider',
      familyKey: 'opencode:new-vision',
      familyLabel: 'New Vision',
      releaseDate: '2026-01-01',
      status: 'active',
      isFree: true,
      capabilities: { inputModalities: ['text', 'image'], outputModalities: ['text'], reasoningEffort: false, reasoning: false, toolCall: true },
    },
  },
  {
    id: 'opencode:reasoner',
    type: 'opencode',
    name: 'Reasoner',
    model_config: {
      model: 'provider/reasoner',
      modelProvider: 'provider',
      familyKey: 'opencode:reasoner',
      familyLabel: 'Reasoner',
      releaseDate: '2025-01-01',
      status: 'active',
      isFree: false,
      capabilities: { inputModalities: ['text'], outputModalities: ['text'], reasoningEffort: false, reasoning: true },
    },
  },
  {
    id: 'opencode:future-pdf',
    type: 'opencode',
    name: 'Future PDF',
    model_config: {
      model: 'provider/future-pdf',
      modelProvider: 'provider',
      familyKey: 'opencode:future-pdf',
      familyLabel: 'Future PDF',
      releaseDate: '2027-01-01',
      status: 'beta',
      isFree: true,
      capabilities: { inputModalities: ['text', 'pdf'], outputModalities: ['text'], reasoningEffort: false, reasoning: false },
    },
  },
  {
    id: 'opencode:image-output',
    type: 'opencode',
    name: 'Image Output',
    model_config: {
      model: 'provider/image-output',
      modelProvider: 'provider',
      familyKey: 'opencode:image-output',
      familyLabel: 'Image Output',
      releaseDate: '2024-01-01',
      status: 'active',
      isFree: false,
      capabilities: { inputModalities: ['text'], outputModalities: ['image'], reasoningEffort: false, reasoning: false },
    },
  },
  {
    id: 'opencode:audio',
    type: 'opencode',
    name: 'Audio Model',
    model_config: {
      model: 'provider/audio',
      modelProvider: 'provider',
      familyKey: 'opencode:audio',
      familyLabel: 'Audio Model',
      releaseDate: '2024-01-01',
      status: 'active',
      isFree: true,
      capabilities: { inputModalities: ['text'], outputModalities: ['audio'], reasoningEffort: false, reasoning: false },
    },
  },
  {
    id: 'opencode:video',
    type: 'opencode',
    name: 'Video Model',
    model_config: {
      model: 'provider/video',
      modelProvider: 'provider',
      familyKey: 'opencode:video',
      familyLabel: 'Video Model',
      releaseDate: '2024-01-01',
      status: 'active',
      isFree: true,
      capabilities: { inputModalities: ['video'], outputModalities: ['text'], reasoningEffort: false, reasoning: false },
    },
  },
];

vi.mock('../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }));
vi.mock('../stores/loginProfilesStore', () => ({
  useLoginProfilesStore: (selector: (state: unknown) => unknown) => selector({ profiles: [{ provider: 'opencode' }] }),
}));
vi.mock('../stores/modelStore', () => ({
  useModelStore: (selector: (state: unknown) => unknown) => selector({
    visibleFamilyKeysByProvider: { codex: undefined, claude: undefined, opencode: undefined },
    setVisibleFamilyKeys: vi.fn(),
  }),
}));

describe('ModelVisibilitySettingsPanel OpenCode filters', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('orders stable models by release before previews and combines capability filters', () => {
    const { container, getByRole, getAllByText, queryAllByText, queryByRole } = render(<ModelVisibilitySettingsPanel initialProvider="opencode" />);
    const rows = Array.from(container.querySelectorAll('label')).map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining('New Vision'),
      expect.stringContaining('Reasoner'),
      expect.stringContaining('Image Output'),
      expect.stringContaining('Future PDF'),
    ]);
    expect(queryAllByText('Audio Model')).toHaveLength(0);
    expect(queryAllByText('Video Model')).toHaveLength(0);
    expect(queryByRole('button', { name: 'Tools' })).toBeNull();
    expect(queryByRole('button', { name: 'PDF' })).toBeNull();
    expect(queryByRole('button', { name: 'Audio' })).toBeNull();
    expect(queryByRole('button', { name: 'Video' })).toBeNull();
    expect(getByRole('button', { name: 'Image output' })).toBeTruthy();

    fireEvent.click(getByRole('button', { name: 'Free models' }));
    expect(getAllByText('New Vision').length).toBeGreaterThan(0);
    expect(getAllByText('Future PDF').length).toBeGreaterThan(0);
    expect(queryAllByText('Reasoner')).toHaveLength(0);

    fireEvent.click(getByRole('button', { name: 'Vision' }));
    expect(getAllByText('New Vision').length).toBeGreaterThan(0);
    expect(queryAllByText('Future PDF')).toHaveLength(0);
  });
});
