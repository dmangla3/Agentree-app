import { describe, expect, it } from 'vitest';
import { buildAgentRuntimeArgs, parseRuntimeCliArgs } from './agentRuntimeArgs';

describe('buildAgentRuntimeArgs', () => {
  it('builds Codex args with permission, provider continuation, and positional prompt', () => {
    const result = buildAgentRuntimeArgs({
      agentType: 'codex',
      cliArgs: '--model gpt-5.5 --reasoning-effort high',
      permissionMode: 'safe-write',
      providerInternalArgs: ['--provider-thread-strategy', 'resume', '--provider-thread-id', 'thread-1'],
      prompt: 'Ship it',
    });

    expect(result.args).toEqual([
      '--model',
      'gpt-5.5',
      '--reasoning-effort',
      'high',
      '--permission-mode',
      'safe-write',
      '--provider-thread-strategy',
      'resume',
      '--provider-thread-id',
      'thread-1',
      'Ship it',
    ]);
    expect(result.parsedModel).toBe('gpt-5.5');
    expect(result.claudeSessionId).toBeNull();
  });

  it('strips obsolete Claude CLI streaming flags and generates a session id', () => {
    const result = buildAgentRuntimeArgs({
      agentType: 'claude',
      cliArgs: '--permission-mode auto --print --output-format stream-json --verbose --no-session-persistence --model sonnet --effort high',
      permissionMode: 'full-access',
      createClaudeSessionId: () => 'session-1',
      providerInternalArgs: ['--provider-thread-strategy', 'fresh_thread'],
      prompt: 'Continue',
    });

    expect(result.args).toEqual([
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--session-id',
      'session-1',
      '--permission-mode',
      'bypassPermissions',
      '--provider-thread-strategy',
      'fresh_thread',
      'Continue',
    ]);
    expect(result.claudeSessionId).toBe('session-1');
  });

  it('preserves an explicit Claude session id', () => {
    const result = buildAgentRuntimeArgs({
      agentType: 'claude',
      cliArgs: '--model opus --session-id existing-session',
      permissionMode: 'safe-write',
      createClaudeSessionId: () => 'new-session',
      prompt: 'Continue',
    });

    expect(result.args).toEqual([
      '--model',
      'opus',
      '--session-id',
      'existing-session',
      '--permission-mode',
      'acceptEdits',
      'Continue',
    ]);
    expect(result.claudeSessionId).toBe('existing-session');
  });
});

describe('parseRuntimeCliArgs', () => {
  it('reads model and permission mode from runtime cli args', () => {
    expect(parseRuntimeCliArgs('--model gpt-5.5 --permission-mode safe-write --reasoning-effort high')).toEqual({
      model: 'gpt-5.5',
      permissionMode: 'safe-write',
      reasoningEffort: 'high',
    });
  });
});
