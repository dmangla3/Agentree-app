import { describe, expect, it } from 'vitest';
import { resolveProviderAssistantOutput } from './agentRunStreamDispatch';

describe('resolveProviderAssistantOutput', () => {
  it('replaces prior Codex assistant item text when a later item completes', () => {
    const result = resolveProviderAssistantOutput('I will inspect first.', 'I inspected and fixed it.', {
      kind: 'snapshot',
      currentProviderItemId: 'msg-initial',
      nextProviderItemId: 'msg-final',
    });

    expect(result.output).toBe('I inspected and fixed it.');
    expect(result.providerItemId).toBe('msg-final');
  });

  it('treats provider stop final content as authoritative', () => {
    const result = resolveProviderAssistantOutput(
      'I will inspect first.I inspected and fixed it.',
      'I inspected and fixed it.',
      { kind: 'final', currentProviderItemId: 'msg-final', nextProviderItemId: null },
    );

    expect(result.output).toBe('I inspected and fixed it.');
    expect(result.providerItemId).toBe('msg-final');
  });

  it('keeps same-item deltas append-only even when text repeats', () => {
    const result = resolveProviderAssistantOutput('the', 'the', {
      kind: 'delta',
      currentProviderItemId: 'msg-1',
      nextProviderItemId: 'msg-1',
    });

    expect(result.output).toBe('thethe');
    expect(result.providerItemId).toBe('msg-1');
  });
});
