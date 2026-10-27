import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  addProviderModelCounts,
  artifactStorage,
  chooseProviderProbeModel,
  classifyProviderProbe,
  directInferenceProbe,
  directProviderCapability,
  eventSessionId,
  filterModelsByProviderCapabilities,
  isAssistantForPrompt,
  isAssistantForPromptSet,
  isPromptSetComplete,
  managedOpenCodeProviderIds,
  normalizeStructuredOutput,
  normalizeModelCatalog,
  normalizeSupportedModelCatalog,
  opencodeErrorDetails,
  opencodeErrorMessage,
  opencodeConfigFromEnv,
  permissionResponse,
  resolveSession,
  opencodePermissionConfig,
  parseOpenCodeModel,
  structuredOutputRecovery,
  toOpenCodeCatalogRecords,
  usageFromAssistantMessage,
} from './opencode-agent-sdk-adapter.mjs';

test('OpenCode model ids retain the underlying provider', () => {
  assert.deepEqual(parseOpenCodeModel('anthropic/claude-sonnet-4-5'), {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-5',
  });
  assert.throws(() => parseOpenCodeModel('claude-sonnet-4-5'), /<provider>\/<model>/);
});

test('OpenRouter direct check reports rejected credentials without inference', async () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentree-opencode-auth-'));
  try {
    fs.mkdirSync(path.join(dataHome, 'opencode'));
    fs.writeFileSync(
      path.join(dataHome, 'opencode', 'auth.json'),
      JSON.stringify({ openrouter: { type: 'api', key: 'sk-or-v1-test' } }),
    );
    const capability = await directProviderCapability('openrouter', {
      env: { XDG_DATA_HOME: dataHome },
      fetchImpl: async (_url, request) => {
        assert.equal(request.headers.Authorization, 'Bearer sk-or-v1-test');
        return {
          status: 401,
          json: async () => ({ error: { message: 'User not found.' } }),
        };
      },
      now: () => 123,
    });

    assert.deepEqual(capability, {
      providerId: 'openrouter',
      credentials: 'invalid',
      pricedModelAccess: 'unknown',
      checkedAt: 123,
      method: 'openrouter_key',
    });
  } finally {
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
});

test('OpenCode ignores ambient provider credentials outside managed auth.json', async () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentree-opencode-auth-'));
  try {
    fs.mkdirSync(path.join(dataHome, 'opencode'));
    fs.writeFileSync(
      path.join(dataHome, 'opencode', 'auth.json'),
      JSON.stringify({ openrouter: { type: 'api', key: 'managed-key' } }),
    );
    const authorization = [];
    await directProviderCapability('openrouter', {
      env: {
        XDG_DATA_HOME: dataHome,
        OPENROUTER_API_KEY: 'ambient-key',
        GROQ_API_KEY: 'ambient-groq-key',
      },
      fetchImpl: async (_url, request) => {
        authorization.push(request.headers.Authorization);
        return { status: 200, json: async () => ({}) };
      },
    });

    assert.deepEqual(authorization, ['Bearer managed-key']);
    assert.deepEqual(managedOpenCodeProviderIds({
      XDG_DATA_HOME: dataHome,
      GROQ_API_KEY: 'ambient-groq-key',
    }), ['opencode', 'openrouter']);
  } finally {
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
});

test('DeepSeek direct check derives credentials and priced access from balance', async () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentree-opencode-auth-'));
  try {
    fs.mkdirSync(path.join(dataHome, 'opencode'));
    fs.writeFileSync(
      path.join(dataHome, 'opencode', 'auth.json'),
      JSON.stringify({ deepseek: { type: 'api', key: 'sk-test' } }),
    );
    const capability = await directProviderCapability('deepseek', {
      env: { XDG_DATA_HOME: dataHome },
      fetchImpl: async (_url, request) => {
        assert.equal(request.headers.Authorization, 'Bearer sk-test');
        return { status: 200, json: async () => ({ is_available: false }) };
      },
      now: () => 456,
    });

    assert.deepEqual(capability, {
      providerId: 'deepseek',
      credentials: 'valid',
      pricedModelAccess: 'unavailable',
      checkedAt: 456,
      method: 'deepseek_balance',
    });
  } finally {
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
});

test('OpenAI identity check validates API credentials without claiming balance', async () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentree-opencode-auth-'));
  try {
    fs.mkdirSync(path.join(dataHome, 'opencode'));
    fs.writeFileSync(
      path.join(dataHome, 'opencode', 'auth.json'),
      JSON.stringify({ openai: { type: 'api', key: 'sk-test' } }),
    );
    const capability = await directProviderCapability('openai', {
      env: { XDG_DATA_HOME: dataHome },
      fetchImpl: async (url, request) => {
        assert.equal(url, 'https://api.openai.com/v1/me');
        assert.equal(request.headers.Authorization, 'Bearer sk-test');
        return { status: 200, json: async () => ({ id: 'user-test' }) };
      },
      now: () => 789,
    });

    assert.deepEqual(capability, {
      providerId: 'openai',
      credentials: 'valid',
      pricedModelAccess: 'unknown',
      checkedAt: 789,
      method: 'openai_identity',
    });
  } finally {
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
});

test('direct provider checks leave transient failures inconclusive', async () => {
  const capability = await directProviderCapability('openrouter', {
    env: { OPENROUTER_API_KEY: 'sk-or-v1-test' },
    fetchImpl: async () => { throw new Error('network unavailable'); },
  });

  assert.equal(capability, null);
});

test('API-key inference probes send one-token requests without tools or agent context', async () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentree-opencode-auth-'));
  try {
    fs.mkdirSync(path.join(dataHome, 'opencode'));
    fs.writeFileSync(
      path.join(dataHome, 'opencode', 'auth.json'),
      JSON.stringify({ groq: { type: 'api', key: 'gsk-test' } }),
    );
    const classification = await directInferenceProbe(
      { providerID: 'groq', modelID: 'llama-3.1-8b-instant' },
      {
        env: { XDG_DATA_HOME: dataHome },
        fetchImpl: async (url, request) => {
          assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
          assert.equal(request.headers.Authorization, 'Bearer gsk-test');
          assert.deepEqual(JSON.parse(request.body), {
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: 'OK' }],
            max_tokens: 1,
            temperature: 0,
            stream: false,
          });
          return { status: 200 };
        },
      },
    );

    assert.deepEqual(classification, {
      credentials: 'valid',
      pricedModelAccess: 'available',
    });
  } finally {
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
});

test('provider probe classification only changes credential and balance states', () => {
  assert.deepEqual(classifyProviderProbe(null), {
    credentials: 'valid',
    pricedModelAccess: 'available',
  });
  assert.deepEqual(classifyProviderProbe({ name: 'APIError', data: { statusCode: 401 } }), {
    credentials: 'invalid',
    pricedModelAccess: 'unknown',
  });
  assert.deepEqual(classifyProviderProbe({ name: 'APIError', data: { statusCode: 402 } }), {
    credentials: 'valid',
    pricedModelAccess: 'unavailable',
  });
  assert.deepEqual(classifyProviderProbe({ name: 'APIError', data: { statusCode: 429, message: 'Rate limited' } }), {
    credentials: 'unknown',
    pricedModelAccess: 'unknown',
  });
  assert.deepEqual(classifyProviderProbe({ name: 'APIError', data: { statusCode: 429, message: 'insufficient_quota' } }), {
    credentials: 'valid',
    pricedModelAccess: 'unavailable',
  });
});

test('OpenCode catalog exposes connected provider metadata and preserves variants', () => {
  const models = normalizeModelCatalog({
    connected: ['openrouter'],
    all: [
      { id: 'openrouter', name: 'OpenRouter', models: { sonnet: { id: 'sonnet:free', name: 'Sonnet', reasoning: true, attachment: true, tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] }, variants: { high: {} }, limit: { context: 200000, output: 64000 }, release_date: '2026-03-01', status: 'active', cost: { input: 0, output: 0 } } } },
      { id: 'openai', name: 'OpenAI', models: { gpt: { id: 'gpt', name: 'GPT' } } },
    ],
  });
  assert.deepEqual(models, [{
    id: 'openrouter/sonnet:free',
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    modelId: 'sonnet:free',
    name: 'Sonnet',
    description: '',
    reasoning: true,
    attachment: true,
    toolCall: true,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    variants: ['high'],
    contextWindow: 200000,
    maxOutputTokens: 64000,
    releaseDate: '2026-03-01',
    status: 'active',
    isFree: true,
  }]);
});

test('OpenCode supported catalog includes providers that are not connected without probing them', () => {
  const catalog = {
    connected: ['opencode'],
    all: [
      { id: 'opencode', name: 'OpenCode Zen', models: { free: { id: 'free', name: 'Free' } } },
      { id: 'openrouter', name: 'OpenRouter', models: { paid: { id: 'paid', name: 'Paid' } } },
    ],
  };

  assert.deepEqual(
    normalizeModelCatalog(catalog).map((model) => model.id),
    ['opencode/free'],
  );
  const supported = normalizeSupportedModelCatalog(catalog);
  assert.deepEqual(supported.map((model) => model.id).sort(), [
    'opencode/free',
    'openrouter/paid',
  ]);

  const records = toOpenCodeCatalogRecords(supported, '1.2.3', 99);
  assert.equal(records[0].provider, 'opencode');
  assert.equal(records[0].canonicalModelId, records[0].id);
  assert.equal(records[0].cliModelId, records[0].id);
  assert.equal(records[0].sourceVersion, '1.2.3');
  assert.equal(records[0].checkedAt, 99);
});

test('OpenCode catalog orders lifecycle groups by newest release and does not guess missing prices are free', () => {
  const models = normalizeModelCatalog({
    connected: ['provider'],
    all: [{
      id: 'provider',
      name: 'Provider',
      models: {
        older: { id: 'older', name: 'Older', release_date: '2025-01-01', status: 'active' },
        alpha: { id: 'alpha', name: 'Alpha', release_date: '2027-01-01', status: 'alpha', cost: { input: 0, output: 0 } },
        newer: { id: 'newer', name: 'Newer', release_date: '2026-01-01', status: 'active', cost: { input: 1, output: 2 } },
        cached: { id: 'cached', name: 'Cached', release_date: '2024-01-01', status: 'active', cost: { input: 0, output: 0, cache: { read: 1, write: 0 } } },
        deprecated: { id: 'deprecated', name: 'Deprecated', release_date: '2028-01-01', status: 'deprecated' },
      },
    }],
  });

  assert.deepEqual(models.map((model) => model.modelId), ['newer', 'older', 'cached', 'alpha', 'deprecated']);
  assert.equal(models.find((model) => model.modelId === 'older').isFree, null);
  assert.equal(models.find((model) => model.modelId === 'alpha').isFree, false);
  assert.equal(models.find((model) => model.modelId === 'newer').isFree, false);
  assert.equal(models.find((model) => model.modelId === 'cached').isFree, false);
});

test('OpenCode catalog does not classify subscription-backed zero-cost models as free', () => {
  const models = normalizeModelCatalog({
    connected: ['openai', 'openrouter', 'opencode'],
    all: [
      { id: 'openai', name: 'OpenAI', models: { codex: { id: 'codex', name: 'Codex', cost: { input: 0, output: 0 } } } },
      { id: 'openrouter', name: 'OpenRouter', models: { router: { id: 'openrouter/free', name: 'Free Router', cost: { input: 0, output: 0 } } } },
      { id: 'opencode', name: 'OpenCode Zen', models: { pickle: { id: 'big-pickle', name: 'Big Pickle', cost: { input: 0, output: 0 } } } },
    ],
  });

  assert.equal(models.find((model) => model.id === 'openai/codex').isFree, false);
  assert.equal(models.find((model) => model.id === 'openrouter/openrouter/free').isFree, true);
  assert.equal(models.find((model) => model.id === 'opencode/big-pickle').isFree, true);
});

test('provider capabilities hide invalid providers and restrict unfunded providers to free models', () => {
  const models = [
    { providerId: 'invalid', modelId: 'paid', isFree: false },
    { providerId: 'free-only', modelId: 'paid', isFree: false },
    { providerId: 'free-only', modelId: 'free', isFree: true },
    { providerId: 'unknown', modelId: 'visible', isFree: false },
  ];
  const filtered = filterModelsByProviderCapabilities(models, [
    { providerId: 'invalid', credentials: 'invalid', pricedModelAccess: 'unknown' },
    { providerId: 'free-only', credentials: 'valid', pricedModelAccess: 'unavailable' },
    { providerId: 'unknown', credentials: 'unknown', pricedModelAccess: 'unknown' },
  ]);

  assert.deepEqual(filtered.map((model) => `${model.providerId}/${model.modelId}`), [
    'free-only/free',
    'unknown/visible',
  ]);
});

test('provider capabilities count actual zero-priced models instead of assuming a free fallback', () => {
  const capabilities = addProviderModelCounts([
    { providerId: 'kimi-for-coding', credentials: 'valid', pricedModelAccess: 'unavailable' },
    { providerId: 'openrouter', credentials: 'valid', pricedModelAccess: 'unavailable' },
  ], [
    { providerId: 'kimi-for-coding', modelId: 'kimi-for-coding', isFree: false },
    { providerId: 'openrouter', modelId: 'paid', isFree: false },
    { providerId: 'openrouter', modelId: 'free', isFree: true },
  ]);

  assert.deepEqual(capabilities.map(({ providerId, modelCount, freeModelCount }) => ({
    providerId,
    modelCount,
    freeModelCount,
  })), [
    { providerId: 'kimi-for-coding', modelCount: 1, freeModelCount: 0 },
    { providerId: 'openrouter', modelCount: 2, freeModelCount: 1 },
  ]);
});

test('provider probe selection uses the cheapest active non-reasoning priced model', () => {
  const selected = chooseProviderProbeModel({
    id: 'provider',
    models: {
      expensive: { id: 'expensive', status: 'active', reasoning: false, cost: { input: 4, output: 8 } },
      reasoning: { id: 'reasoning', status: 'active', reasoning: true, cost: { input: 0.1, output: 0.1 } },
      cheap: { id: 'cheap', status: 'active', reasoning: false, cost: { input: 0.2, output: 0.3 } },
      guard: { id: 'prompt-guard', status: 'active', reasoning: false, cost: { input: 0.01, output: 0.01 } },
      free: { id: 'free', status: 'active', reasoning: false, cost: { input: 0, output: 0 } },
    },
  });

  assert.deepEqual(selected, { providerID: 'provider', modelID: 'cheap', priced: true });
});

test('OpenCode safe-write permissions only allow worktree edits', () => {
  const permission = opencodePermissionConfig('safe-write', '/repo/worktree');
  assert.equal(permission.edit['*'], 'deny');
  assert.equal(permission.edit['/repo/worktree/**'], 'allow');
  assert.equal(permission.external_directory, 'ask');
  assert.equal(permissionResponse('safe-write', 'external_directory', 'read'), 'once');
  assert.equal(permissionResponse('safe-write', 'external_directory', 'bash'), 'reject');
  assert.equal(permissionResponse('safe-write', 'external_directory', 'edit'), 'reject');
});

test('OpenCode fully-isolated mode blocks external and network tools', () => {
  const permission = opencodePermissionConfig('fully-isolated', '/repo/worktree');
  assert.equal(permission.bash, 'deny');
  assert.equal(permission.external_directory, 'deny');
  assert.equal(permission.webfetch, 'deny');
  assert.equal(permission.websearch, 'deny');
});

test('OpenCode config injects Agentree MCP without replacing provider config', () => {
  const config = opencodeConfigFromEnv('full-access', '/repo', { AGENTREE_MCP_URL: 'http://127.0.0.1:4567/mcp' });
  assert.deepEqual(config.enabled_providers, ['opencode']);
  assert.deepEqual(config.mcp.agentree, {
    type: 'remote',
    url: 'http://127.0.0.1:4567/mcp',
    enabled: true,
    oauth: false,
  });
});

test('OpenCode event helpers normalize session, structured output, and usage', () => {
  assert.equal(eventSessionId({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_1' } } }), 'ses_1');
  assert.deepEqual(normalizeStructuredOutput({ final_response: 'Done', commit_subject: 'feat: done' }), {
    finalResponse: 'Done',
    commitSubject: 'feat: done',
    commitBody: null,
    aiLabel: null,
    threadTitle: null,
  });
  assert.deepEqual(usageFromAssistantMessage({ tokens: { input: 4, output: 5, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 0.01 }), {
    input_tokens: 4,
    output_tokens: 5,
    reasoning_tokens: 2,
    cached_input_tokens: 3,
    cache_creation_input_tokens: 1,
    total_tokens: 11,
    cost_usd: 0.01,
  });
  assert.equal(opencodeErrorMessage({ name: 'APIError', data: { message: 'Upstream failed' } }), 'Upstream failed');
});

test('OpenCode turn correlation ignores stale and title assistant events', () => {
  assert.equal(isAssistantForPrompt({ role: 'assistant', parentID: 'msg_current', mode: 'build' }, 'msg_current'), true);
  assert.equal(isAssistantForPrompt({ role: 'assistant', parentID: 'msg_previous', mode: 'build' }, 'msg_current'), false);
  assert.equal(isAssistantForPrompt({ role: 'assistant', parentID: 'msg_current', mode: 'title' }, 'msg_current'), false);
});

test('OpenCode queued steering remains active until every accepted prompt responds', () => {
  const requestMessageIDs = new Set(['msg_initial', 'msg_steer']);
  const turn = {
    requestMessageIDs,
    respondedRequestIDs: new Set(['msg_initial']),
    pendingPromptSubmissions: 0,
  };

  assert.equal(isAssistantForPromptSet(
    { role: 'assistant', parentID: 'msg_steer', mode: 'build' },
    requestMessageIDs,
  ), true);
  assert.equal(isPromptSetComplete(turn), false);
  turn.respondedRequestIDs.add('msg_steer');
  assert.equal(isPromptSetComplete(turn), true);
  turn.pendingPromptSubmissions = 1;
  assert.equal(isPromptSetComplete(turn), false);
});

test('OpenCode sessions create, resume, and fork at the exact provider turn', async () => {
  const calls = [];
  const client = {
    session: {
      create: async (request) => {
        calls.push(['create', request]);
        return { data: { id: 'session-new' } };
      },
      fork: async (request) => {
        calls.push(['fork', request]);
        return { data: { id: 'session-fork' } };
      },
    },
  };

  assert.deepEqual(await resolveSession(client, { providerThreadStrategy: 'fresh_thread' }), {
    sessionID: 'session-new',
    strategy: 'fresh_thread',
    sourceThreadId: null,
  });
  assert.deepEqual(await resolveSession(client, {
    providerThreadStrategy: 'resume',
    sourceProviderThreadId: 'session-source',
  }), {
    sessionID: 'session-source',
    strategy: 'resume',
    sourceThreadId: 'session-source',
  });
  assert.deepEqual(await resolveSession(client, {
    providerThreadStrategy: 'fork_at_turn',
    sourceProviderThreadId: 'session-source',
    targetProviderTurnId: 'message-target',
  }), {
    sessionID: 'session-fork',
    strategy: 'fork_at_turn',
    sourceThreadId: 'session-source',
  });
  assert.deepEqual(calls, [
    ['create', { body: {} }],
    ['fork', { path: { id: 'session-source' }, body: { messageID: 'message-target' } }],
  ]);
});

test('OpenCode continuation rejects incomplete native lineage', async () => {
  const client = { session: { create: async () => ({ data: { id: 'unused' } }) } };
  await assert.rejects(
    resolveSession(client, { providerThreadStrategy: 'resume' }),
    /requires a provider thread id/
  );
  await assert.rejects(
    resolveSession(client, {
      providerThreadStrategy: 'fork_at_turn',
      sourceProviderThreadId: 'session-source',
    }),
    /requires provider thread and turn ids/
  );
});

test('OpenCode errors expose sanitized provider diagnostics', () => {
  const error = {
    name: 'APIError',
    data: {
      message: 'Upstream request failed',
      statusCode: 400,
      responseBody: JSON.stringify({ error: { message: 'Provider rejected tool_choice' } }),
      responseHeaders: { authorization: 'secret' },
    },
  };
  assert.deepEqual(opencodeErrorDetails(error), {
    name: 'APIError',
    message: 'Upstream request failed',
    statusCode: 400,
    providerMessage: 'Provider rejected tool_choice',
  });
  assert.equal(opencodeErrorMessage(error), 'Upstream request failed (HTTP 400)');
});

test('OpenCode preserves usable text when only structured metadata failed', () => {
  assert.equal(structuredOutputRecovery({
    error: { name: 'StructuredOutputError', data: { message: 'Model did not produce structured output' } },
    finalText: 'Done',
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    toolActivity: false,
  }), 'use_text');
});

test('OpenCode retries a rejected structured request only before any progress', () => {
  const error = { name: 'APIError', data: { message: 'Upstream request failed', statusCode: 400 } };
  const emptyUsage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
  assert.equal(structuredOutputRecovery({ error, finalText: '', usage: emptyUsage, toolActivity: false }), 'retry_plain');
  assert.equal(structuredOutputRecovery({ error, finalText: '', usage: emptyUsage, toolActivity: true }), null);
  assert.equal(structuredOutputRecovery({ error, finalText: 'partial', usage: emptyUsage, toolActivity: false }), null);
  assert.equal(structuredOutputRecovery({
    error,
    finalText: '',
    usage: { ...emptyUsage, output_tokens: 1, total_tokens: 1 },
    toolActivity: false,
  }), null);
});

test('OpenCode file parts map to Agentree artifact storage backends', () => {
  assert.deepEqual(artifactStorage('file:///tmp/output.png'), {
    backend: 'local',
    path: '/tmp/output.png',
  });
  assert.deepEqual(artifactStorage('data:image/png;base64,AA=='), {
    backend: 'inline',
    url: 'data:image/png;base64,AA==',
  });
});
