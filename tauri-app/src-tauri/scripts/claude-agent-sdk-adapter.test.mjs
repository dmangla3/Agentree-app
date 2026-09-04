import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

test('direct execution detection follows symlinked argv paths', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');
  const root = await mkdtemp(join(tmpdir(), 'agentree-adapter-main-'));
  try {
    const realDir = join(root, 'real');
    const linkDir = join(root, 'link');
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);
    const script = join(realDir, 'adapter.mjs');
    writeFileSync(script, '');

    assert.equal(adapter.isDirectExecution(pathToFileURL(script).href, join(linkDir, 'adapter.mjs')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude steer interrupt results keep the provider stream open', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  assert.equal(adapter.isSteerContinuationResult({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'interrupt',
    terminal_reason: 'aborted_streaming',
  }, 1), true);

  assert.equal(adapter.isSteerContinuationResult({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
  }, 1), false);

  assert.equal(adapter.isSteerContinuationResult({
    type: 'result',
    subtype: 'error',
    is_error: true,
    stop_reason: 'interrupt',
    terminal_reason: 'aborted_streaming',
  }, 1), false);
});

test('Claude tool use events preserve provider item and structured input', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  const event = adapter.toolStartedEventFromBlock({
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Read',
    input: {
      file_path: 'tauri-app/src-tauri/src/agents.rs',
      offset: 817,
      limit: 99,
    },
  });

  assert.equal(event.type, 'tool_use');
  assert.equal(event.toolName, 'Read');
  assert.deepEqual(event.input, {
    file_path: 'tauri-app/src-tauri/src/agents.rs',
    offset: 817,
    limit: 99,
  });
  assert.deepEqual(event.tool_input, event.input);
  assert.equal(event.provider_item.id, 'toolu_1');
  assert.equal(event.provider_item_id, 'toolu_1');
});

test('Claude input_json_delta chunks reconstruct tool input', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  let state = adapter.mergeToolInputDelta(null, {
    type: 'input_json_delta',
    partial_json: '{"file_path":"tauri-app/src-tauri/src/agents.rs",',
  });
  assert.equal(state.input, null);

  state = adapter.mergeToolInputDelta(state, {
    type: 'input_json_delta',
    partial_json: '"offset":817,"limit":99}',
  });

  assert.deepEqual(state.input, {
    file_path: 'tauri-app/src-tauri/src/agents.rs',
    offset: 817,
    limit: 99,
  });
});
