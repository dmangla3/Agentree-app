import { describe, expect, it } from 'vitest';
import {
  applyComposerPermissionArgs,
  DEFAULT_COMPOSER_PERMISSION_MODE,
  getComposerPermissionOption,
  normalizeComposerPermissionMode,
  removeProviderPermissionArgs,
} from './composerPermissions';

describe('composer permissions', () => {
  it('defaults to full access', () => {
    expect(DEFAULT_COMPOSER_PERMISSION_MODE).toBe('full-access');
    expect(normalizeComposerPermissionMode(null)).toBe('full-access');
    expect(getComposerPermissionOption(DEFAULT_COMPOSER_PERMISSION_MODE).label).toBe('Full access');
  });

  it('removes stale provider permission flags before applying the composer choice', () => {
    expect(removeProviderPermissionArgs([
      '--model',
      'sonnet',
      '--permission-mode',
      'auto',
      '--dangerously-skip-permissions',
      '--verbose',
    ])).toEqual(['--model', 'sonnet', '--verbose']);
  });

  it('maps composer modes to codex permission args', () => {
    expect(applyComposerPermissionArgs(['--model', 'gpt-5.5'], 'codex', 'fully-isolated')).toEqual([
      '--model',
      'gpt-5.5',
      '--permission-mode',
      'fully-isolated',
    ]);
    expect(applyComposerPermissionArgs(['--model', 'gpt-5.5'], 'codex', 'safe-write')).toContain('safe-write');
    expect(applyComposerPermissionArgs(['--model', 'gpt-5.5'], 'codex', 'full-access')).toContain('full-access');
  });

  it('maps composer modes to claude sdk permission args', () => {
    expect(applyComposerPermissionArgs([], 'claude', 'fully-isolated')).toEqual(['--permission-mode', 'default']);
    expect(applyComposerPermissionArgs([], 'claude', 'safe-write')).toEqual(['--permission-mode', 'acceptEdits']);
    expect(applyComposerPermissionArgs([], 'claude', 'full-access')).toEqual(['--permission-mode', 'bypassPermissions']);
  });
});
