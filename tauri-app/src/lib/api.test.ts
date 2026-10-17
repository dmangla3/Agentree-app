import { describe, expect, it, vi } from 'vitest';
import {
  AGENTREE_DATA_PLANE_DISABLED_MESSAGE,
  AGENTREE_DATA_PLANE_ENABLED,
  api,
  getErrorMessage,
} from './api';

describe('Agentree data plane boundary', () => {
  it('blocks requests before an HTTP adapter can run', async () => {
    const adapter = vi.fn();

    expect(AGENTREE_DATA_PLANE_ENABLED).toBe(false);
    await expect(api.get('/should-never-send', { adapter })).rejects.toThrow(
      AGENTREE_DATA_PLANE_DISABLED_MESSAGE,
    );
    expect(adapter).not.toHaveBeenCalled();
  });
});

describe('getErrorMessage', () => {
  it('returns plain string errors from Tauri invoke rejections', () => {
    expect(getErrorMessage('Codex readiness check produced no output')).toBe(
      'Codex readiness check produced no output',
    );
  });
});
