import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Agentree-managed Claude credentials bypass local CLI auth probe', async () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test';
  try {
    const adapter = await import('./claude-agent-sdk-adapter.mjs');
    assert.equal(adapter.hasAgentreeManagedClaudeCredential(), true);
    assert.equal(adapter.probeClaudeAuth(), null);
  } finally {
    if (originalApiKey == null) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  }
});
