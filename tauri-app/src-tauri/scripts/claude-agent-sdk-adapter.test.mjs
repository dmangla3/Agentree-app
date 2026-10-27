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

test('Claude readiness initializes the SDK without starting a model turn', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');
  let received = null;
  const result = await adapter.probeClaudeSdkReadiness((request) => {
    received = request;
    return {
      initializationResult: async () => ({
        account: { tokenSource: 'oauth', subscriptionType: 'pro' },
      }),
    };
  });

  assert.equal(typeof received.prompt?.[Symbol.asyncIterator], 'function');
  assert.equal(received.options.maxTurns, 0);
  assert.equal(received.options.persistSession, false);
  assert.deepEqual(received.options.allowedTools, []);
  assert.equal(received.options.abortController.signal.aborted, true);
  assert.deepEqual(await received.prompt[Symbol.asyncIterator]().next(), {
    value: undefined,
    done: true,
  });
  assert.deepEqual(result, {
    status: 'ready',
    authMode: 'oauth',
    planType: 'pro',
    message: 'Claude account is ready.',
  });
});

test('Claude readiness classifies expired credentials as missing auth', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');
  const result = await adapter.probeClaudeSdkReadiness(() => ({
    initializationResult: async () => {
      throw new Error('OAuth token expired; login required');
    },
  }));

  assert.equal(result.status, 'auth_missing');
  assert.match(result.message, /expired/);
});

test('Claude model catalog comes from SDK initialization without starting a turn', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');
  let received = null;
  const models = await adapter.listClaudeModelCatalog((request) => {
    received = request;
    return {
      initializationResult: async () => ({
        models: [{
          value: 'sonnet',
          resolvedModel: 'claude-sonnet-5',
          displayName: 'Sonnet 5',
          description: 'Fast and capable.',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
        }],
      }),
    };
  }, 1234);

  assert.equal(received.options.maxTurns, 0);
  assert.equal(received.options.persistSession, false);
  assert.equal(received.options.abortController.signal.aborted, true);
  assert.deepEqual(models, [{
    provider: 'claude',
    canonicalModelId: 'claude-sonnet-5',
    cliModelId: 'sonnet',
    name: 'Sonnet 5',
    description: 'Fast and capable.',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: null,
    inputModalities: ['text'],
    outputModalities: ['text'],
    hidden: false,
    isDefault: null,
    status: 'active',
    isFree: null,
    sourceVersion: null,
    checkedAt: 1234,
  }]);
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
test('Claude structured output schema carries commit body guidance', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  assert.ok(adapter.FINAL_RESULT_SCHEMA.required.includes('commit_body'));
  assert.match(
    adapter.FINAL_RESULT_SCHEMA.properties.commit_subject.description,
    /Conventional Commits format/
  );
  assert.match(
    adapter.FINAL_RESULT_SCHEMA.properties.commit_body.description,
    /1-3 short paragraphs/
  );

  const output = adapter.structuredFinalOutputFromInput({
    final_response: 'Done',
    commit_subject: '  `feat: add commit bodies.`  ',
    commit_body: ' Explain why.\n\nMention adapter schemas. ',
    ai_label: null,
    thread_title: null,
  });

  assert.equal(output.commitSubject, 'feat: add commit bodies');
  assert.equal(output.commitBody, 'Explain why.\n\nMention adapter schemas.');
});

test('Claude structured output ignores partial tool input', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  assert.equal(adapter.structuredFinalOutputFromInput({
    final_response: 'Done</final_response>\n<commit_subject>Bad shape</commit_subject>',
  }), null);

  assert.deepEqual(adapter.structuredFinalOutputFromInput({
    final_response: 'Done',
    commit_subject: null,
    commit_body: null,
    ai_label: 'Finished work',
    thread_title: null,
  }), {
    finalResponse: 'Done',
    commitSubject: null,
    commitBody: null,
    aiLabel: 'Finished work',
    threadTitle: null,
  });

  assert.equal(adapter.structuredFinalOutputFromInput({
    final_response: null,
    commit_subject: 'fix: update adapter',
    commit_body: null,
    ai_label: 'Updated adapter',
    thread_title: null,
  }), null);
});

test('Claude structured output fallback is limited to exhausted metadata failures', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');
  const failedResult = {
    type: 'result',
    is_error: true,
    stop_reason: 'tool_use',
  };

  assert.equal(adapter.shouldFallbackAfterStructuredOutputFailure({
    message: failedResult,
    structuredOutputFailureCount: 2,
    structuredFinalOutput: null,
    fallbackFinalContent: 'Clean final answer',
  }), false);

  assert.equal(adapter.shouldFallbackAfterStructuredOutputFailure({
    message: failedResult,
    structuredOutputFailureCount: 3,
    structuredFinalOutput: null,
    fallbackFinalContent: 'Clean final answer',
  }), true);

  assert.equal(adapter.shouldFallbackAfterStructuredOutputFailure({
    message: failedResult,
    structuredOutputFailureCount: 3,
    structuredFinalOutput: { finalResponse: 'Done' },
    fallbackFinalContent: 'Clean final answer',
  }), false);
});

test('Claude structured output tool errors are detected but not emitted as normal tool results', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');
  const message = {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_structured', is_error: true, content: 'schema failed' },
        { type: 'tool_result', tool_use_id: 'toolu_read', is_error: false, content: 'ok' },
      ],
    },
  };

  assert.deepEqual(adapter.structuredOutputToolErrors(message, new Set(['toolu_structured'])), [
    { type: 'tool_result', tool_use_id: 'toolu_structured', is_error: true, content: 'schema failed' },
  ]);
});

test('worktree write guard denies writes outside the worktree and allows inside', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');
  const worktree = '/home/user/.agentree/worktrees/abc/nodes/node-1';

  // Inside the worktree (absolute) -> allowed (null).
  assert.equal(
    adapter.worktreeWriteEscapeDenial('Edit', { file_path: `${worktree}/src/app.ts` }, worktree),
    null
  );
  // Relative path resolves under the worktree -> allowed.
  assert.equal(
    adapter.worktreeWriteEscapeDenial('Write', { file_path: 'src/new.ts' }, worktree),
    null
  );

  // Absolute path into the user's main checkout -> denied.
  const escape = adapter.worktreeWriteEscapeDenial(
    'Write',
    { file_path: '/home/user/projects/Agentree/src/app.ts' },
    worktree
  );
  assert.equal(escape?.behavior, 'deny');
  assert.match(escape.message, /outside this agent's worktree/);

  // `..` traversal out of the worktree -> denied.
  const traversal = adapter.worktreeWriteEscapeDenial(
    'Edit',
    { file_path: `${worktree}/../../../escape.ts` },
    worktree
  );
  assert.equal(traversal?.behavior, 'deny');

  // NotebookEdit uses notebook_path; outside -> denied.
  const notebook = adapter.worktreeWriteEscapeDenial(
    'NotebookEdit',
    { notebook_path: '/etc/passwd.ipynb' },
    worktree
  );
  assert.equal(notebook?.behavior, 'deny');
});

test('worktree write guard does not interfere with non-write tools or missing paths', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');
  const worktree = '/home/user/.agentree/worktrees/abc/nodes/node-1';

  // Read / Bash / other tools are never guarded.
  assert.equal(adapter.worktreeWriteEscapeDenial('Read', { file_path: '/etc/hosts' }, worktree), null);
  assert.equal(adapter.worktreeWriteEscapeDenial('Bash', { command: 'rm -rf /' }, worktree), null);

  // Write tool without a usable path is left untouched (the tool itself errors).
  assert.equal(adapter.worktreeWriteEscapeDenial('Write', {}, worktree), null);
  assert.equal(adapter.worktreeWriteEscapeDenial('Edit', { file_path: '  ' }, worktree), null);
});

test('Claude default permission mode enables isolated sandbox', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  const options = adapter.claudeOptionsForPermissionMode('default', '/repo/worktree', {
    AGENT_SANDBOX: '/tmp/agent-sandbox',
    AGENTREE_SHARED_CACHE: '/cache/agentree/shared',
    XDG_CACHE_HOME: '/tmp/agent-sandbox/cache',
    pnpm_config_store_dir: '/cache/agentree/shared/pnpm-store',
    CARGO_TARGET_DIR: '/tmp/agent-sandbox/cargo-target',
  });

  assert.equal(options.permissionMode, 'default');
  assert.equal(options.sandbox.enabled, true);
  assert.equal(options.sandbox.failIfUnavailable, true);
  assert.equal(options.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(options.sandbox.network, {
    allowedDomains: [],
    deniedDomains: ['*'],
  });
  assert.deepEqual(options.sandbox.filesystem.denyRead, ['/']);
  assert.deepEqual(options.sandbox.filesystem.allowRead, [
    '/repo/worktree',
    '/tmp/agent-sandbox',
    '/cache/agentree/shared',
    '/tmp/agent-sandbox/cache',
    '/cache/agentree/shared/pnpm-store',
    '/tmp/agent-sandbox/cargo-target',
  ]);
  assert.deepEqual(options.sandbox.filesystem.allowWrite, [
    '/repo/worktree',
    '/tmp/agent-sandbox',
    '/cache/agentree/shared',
    '/tmp/agent-sandbox/cache',
    '/cache/agentree/shared/pnpm-store',
    '/tmp/agent-sandbox/cargo-target',
  ]);
});

test('Claude acceptEdits permission mode keeps network and full reads but sandboxes writes', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  const options = adapter.claudeOptionsForPermissionMode('acceptEdits', '/repo/worktree', {
    AGENTREE_AGENT_SANDBOX: '/tmp/agent-sandbox',
    TMPDIR: '/tmp/agent-sandbox/tmp',
    npm_config_cache: '/tmp/agent-sandbox/npm-cache',
  });

  assert.equal(options.permissionMode, 'acceptEdits');
  assert.equal(options.sandbox.enabled, true);
  assert.equal(options.sandbox.failIfUnavailable, true);
  assert.equal(options.sandbox.allowUnsandboxedCommands, false);
  assert.equal(options.sandbox.network, undefined);
  assert.equal(options.sandbox.filesystem.denyRead, undefined);
  assert.equal(options.sandbox.filesystem.allowRead, undefined);
  assert.deepEqual(options.sandbox.filesystem.allowWrite, [
    '/repo/worktree',
    '/tmp/agent-sandbox',
    '/tmp/agent-sandbox/tmp',
    '/tmp/agent-sandbox/npm-cache',
  ]);
});

test('Claude bypassPermissions skips sandbox and opts into dangerous permission bypass', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  assert.deepEqual(adapter.claudeOptionsForPermissionMode('bypassPermissions', '/repo/worktree', {
    AGENT_SANDBOX: '/tmp/agent-sandbox',
  }), {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  });
});

test('Claude mapper tolerates composer permission mode ids', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  assert.equal(
    adapter.claudeOptionsForPermissionMode('fully-isolated', '/repo/worktree', {}).permissionMode,
    'default',
  );
  assert.equal(
    adapter.claudeOptionsForPermissionMode('safe-write', '/repo/worktree', {}).permissionMode,
    'acceptEdits',
  );
  assert.deepEqual(adapter.claudeOptionsForPermissionMode('full-access', '/repo/worktree', {}), {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  });
});

test('Claude adapter derives Agentree MCP server config from environment', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  assert.deepEqual(adapter.agentreeMcpServersFromEnv({
    AGENTREE_MCP_URL: ' http://127.0.0.1:61234/mcp ',
  }), {
    agentree: {
      type: 'http',
      url: 'http://127.0.0.1:61234/mcp',
    },
  });
  assert.deepEqual(adapter.agentreeMcpServersFromEnv({
    MCP_SERVER_URL: 'http://127.0.0.1:61235/mcp',
  }), {
    agentree: {
      type: 'http',
      url: 'http://127.0.0.1:61235/mcp',
    },
  });
  assert.equal(adapter.agentreeMcpServersFromEnv({}), null);
});

test('Claude adapter preserves normal filesystem customizations and MCP configs', async () => {
  const adapter = await import('./claude-agent-sdk-adapter.mjs');

  assert.deepEqual(adapter.claudeCustomizationOptions(), {
    settingSources: ['user', 'project', 'local'],
    strictMcpConfig: false,
  });
});
