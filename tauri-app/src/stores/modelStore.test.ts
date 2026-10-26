import { beforeEach, describe, expect, it } from 'vitest';
import { isModelFamilyVisible, useModelStore } from './modelStore';

describe('modelStore visibility preferences', () => {
  beforeEach(() => {
    useModelStore.setState({ visibleFamilyKeysByProvider: {} });
  });

  it('shows every family until a provider is explicitly configured', () => {
    expect(isModelFamilyVisible({}, 'opencode', 'opencode:openrouter%2Fmodel')).toBe(true);
  });

  it('persists an explicit family allowlist and can reset to show all', () => {
    useModelStore.getState().setVisibleFamilyKeys('opencode', ['opencode:openrouter%2Fmodel']);

    expect(isModelFamilyVisible(
      useModelStore.getState().visibleFamilyKeysByProvider,
      'opencode',
      'opencode:openrouter%2Fmodel',
    )).toBe(true);
    expect(isModelFamilyVisible(
      useModelStore.getState().visibleFamilyKeysByProvider,
      'opencode',
      'opencode:openrouter%2Fother',
    )).toBe(false);

    useModelStore.getState().setVisibleFamilyKeys('opencode', null);
    expect(isModelFamilyVisible(
      useModelStore.getState().visibleFamilyKeysByProvider,
      'opencode',
      'opencode:openrouter%2Fother',
    )).toBe(true);
  });
});
