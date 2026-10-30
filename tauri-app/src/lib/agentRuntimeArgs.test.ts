import { describe, expect, it } from 'vitest';
import { parseRuntimeCliArgs } from './agentRuntimeArgs';

describe('parseRuntimeCliArgs', () => {
  it('reads model, permission mode, and reasoning effort from runtime cli args', () => {
    expect(parseRuntimeCliArgs('--model gpt-5.5 --permission-mode safe-write --reasoning-effort high')).toEqual({
      model: 'gpt-5.5',
      permissionMode: 'safe-write',
      reasoningEffort: 'high',
    });
  });
});
