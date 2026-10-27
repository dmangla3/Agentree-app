import { beforeEach, describe, expect, it } from 'vitest';
import {
  getEffectiveVisibleFamilyKeys,
  isModelFamilyVisible,
  useModelStore,
} from './modelStore';

describe('modelStore visibility preferences', () => {
  beforeEach(() => {
    useModelStore.setState({ visibleFamilyKeysByProvider: {} });
  });

  it('keeps models hidden until a provider gets its initial explicit snapshot', () => {
    expect(isModelFamilyVisible({}, 'opencode', 'opencode:openrouter%2Fmodel')).toBe(false);

    useModelStore.getState().initializeVisibleFamilyKeys('opencode', ['opencode:openrouter%2Fmodel']);
    expect(isModelFamilyVisible(
      useModelStore.getState().visibleFamilyKeysByProvider,
      'opencode',
      'opencode:openrouter%2Fmodel',
    )).toBe(true);
  });

  it('does not automatically select models discovered after initialization', () => {
    useModelStore.getState().initializeVisibleFamilyKeys('opencode', ['opencode:openrouter%2Fmodel']);
    useModelStore.getState().initializeVisibleFamilyKeys('opencode', [
      'opencode:openrouter%2Fmodel',
      'opencode:openrouter%2Fnew-model',
    ]);

    expect(useModelStore.getState().visibleFamilyKeysByProvider.opencode).toEqual([
      'opencode:openrouter%2Fmodel',
    ]);
  });

  it('persists an explicit family allowlist', () => {
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

  });

  it('retains inaccessible choices while deriving the effective intersection', () => {
    const desired = ['opencode:openai%2Fgpt', 'opencode:openrouter%2Fmissing'];
    expect(getEffectiveVisibleFamilyKeys(desired, ['opencode:openai%2Fgpt'])).toEqual([
      'opencode:openai%2Fgpt',
    ]);
    expect(desired).toContain('opencode:openrouter%2Fmissing');
  });
});
