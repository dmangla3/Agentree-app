import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './api';

describe('getErrorMessage', () => {
  it('returns plain string errors from Tauri invoke rejections', () => {
    expect(getErrorMessage('Codex readiness check produced no output')).toBe(
      'Codex readiness check produced no output',
    );
  });
});
