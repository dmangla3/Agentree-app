#!/usr/bin/env node

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { createOpencodeClient } from '@opencode-ai/sdk';

const SERVER_START_TIMEOUT_MS = 15_000;

export const FINAL_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['final_response', 'commit_subject', 'commit_body', 'ai_label', 'thread_title'],
  properties: {
    final_response: { type: 'string' },
    commit_subject: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    commit_body: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    ai_label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    thread_title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

const nowMs = () => Date.now();
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

export function isDirectExecution(moduleUrl, argvPath) {
  if (!argvPath) return false;
  try {
    return fs.realpathSync(new URL(moduleUrl)) === fs.realpathSync(argvPath);
  } catch {
    return new URL(moduleUrl).pathname === path.resolve(argvPath);
  }
}

export function parseOpenCodeModel(value) {
  const raw = String(value || '').trim();
  const separator = raw.indexOf('/');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error('OpenCode models must use the full <provider>/<model> id.');
  }
  return { providerID: raw.slice(0, separator), modelID: raw.slice(separator + 1) };
}

function providerAuthEntry(providerID, env = process.env) {
  const dataHome = String(env.XDG_DATA_HOME || '').trim()
    || (env.HOME ? path.join(env.HOME, '.local', 'share') : '');
  if (!dataHome) return null;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(dataHome, 'opencode', 'auth.json'), 'utf8'));
    return auth?.[providerID] && typeof auth[providerID] === 'object' ? auth[providerID] : null;
  } catch {
    return null;
  }
}

export function managedOpenCodeProviderIds(env = process.env) {
  const dataHome = String(env.XDG_DATA_HOME || '').trim()
    || (env.HOME ? path.join(env.HOME, '.local', 'share') : '');
  let managed = [];
  if (dataHome) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(dataHome, 'opencode', 'auth.json'), 'utf8'));
      if (auth && typeof auth === 'object' && !Array.isArray(auth)) managed = Object.keys(auth);
    } catch { /* An empty profile can still use OpenCode Zen's built-in models. */ }
  }
  return Array.from(new Set(['opencode', ...managed])).sort();
}

function providerApiKey(providerID, env = process.env) {
  return String(providerAuthEntry(providerID, env)?.key || '').trim();
}

export async function directInferenceProbe(
  selected,
  { env = process.env, fetchImpl = globalThis.fetch } = {},
) {
  const endpoint = {
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    'kimi-for-coding': 'https://api.kimi.com/coding/v1/chat/completions',
    opencode: 'https://opencode.ai/zen/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  }[selected?.providerID];
  if (!endpoint) return null;
  const key = providerApiKey(selected.providerID, env);
  if (!key) return null;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: selected.modelID,
        messages: [{ role: 'user', content: 'OK' }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status >= 200 && response.status < 300) {
      return { credentials: 'valid', pricedModelAccess: 'available' };
    }
    let responseBody = '';
    try {
      responseBody = JSON.stringify(await response.json());
    } catch { /* Classification can still use the status code. */ }
    return classifyProviderProbe({
      name: 'APIError',
      data: { statusCode: response.status, responseBody },
    });
  } catch {
    return { credentials: 'unknown', pricedModelAccess: 'unknown' };
  }
}

export async function directProviderCapability(
  providerID,
  { env = process.env, fetchImpl = globalThis.fetch, now = nowMs } = {},
) {
  if (!['deepseek', 'openai', 'openrouter'].includes(providerID)) return null;
  const auth = providerAuthEntry(providerID, env);
  if (providerID === 'openai' && auth?.type !== 'api') return null;
  const token = String(auth?.key || auth?.access || '').trim();
  if (!token) return null;
  const endpoint = {
    deepseek: 'https://api.deepseek.com/user/balance',
    openai: 'https://api.openai.com/v1/me',
    openrouter: 'https://openrouter.ai/api/v1/key',
  }[providerID];
  const method = {
    deepseek: 'deepseek_balance',
    openai: 'openai_identity',
    openrouter: 'openrouter_key',
  }[providerID];
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401) {
      return {
        providerId: providerID,
        credentials: 'invalid',
        pricedModelAccess: 'unknown',
        checkedAt: now(),
        method,
      };
    }
    if (response.status !== 200) return null;
    const body = await response.json();
    if (providerID === 'openai') {
      return {
        providerId: providerID,
        credentials: 'valid',
        pricedModelAccess: 'unknown',
        checkedAt: now(),
        method,
      };
    }
    if (providerID === 'deepseek') {
      if (typeof body?.is_available !== 'boolean') return null;
      return {
        providerId: providerID,
        credentials: 'valid',
        pricedModelAccess: body.is_available ? 'available' : 'unavailable',
        checkedAt: now(),
        method,
      };
    }
    const remaining = body?.data?.limit_remaining;
    return {
      providerId: providerID,
      credentials: 'valid',
      pricedModelAccess: typeof remaining === 'number' && remaining <= 0 ? 'unavailable' : 'unknown',
      checkedAt: now(),
      method,
    };
  } catch {
    return null;
  }
}

export function classifyProviderProbe(error) {
  if (!error) return { credentials: 'valid', pricedModelAccess: 'available' };
  const details = opencodeErrorDetails(error);
  if (details?.statusCode === 401) {
    return { credentials: 'invalid', pricedModelAccess: 'unknown' };
  }
  const balanceText = `${details?.message || ''} ${details?.providerMessage || ''}`.toLowerCase();
  if (
    details?.statusCode === 402
    || balanceText.includes('insufficient_quota')
    || balanceText.includes('insufficient balance')
    || balanceText.includes('insufficient credit')
    || balanceText.includes('blocked_api_access')
    || balanceText.includes('payment required')
  ) {
    return { credentials: 'valid', pricedModelAccess: 'unavailable' };
  }
  return { credentials: 'unknown', pricedModelAccess: 'unknown' };
}

export function chooseProviderProbeModel(provider) {
  const unsuitable = /(audio|embed|guard|moderation|rerank|speech|transcri|tts|whisper)/i;
  const candidates = Object.values(provider?.models || {})
    .filter((model) => model?.id && model.status !== 'deprecated' && !unsuitable.test(`${model.id} ${model.name || ''}`))
    .map((model) => {
      const input = Number(model.cost?.input);
      const output = Number(model.cost?.output);
      const hasPrice = Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0);
      return {
        providerID: provider.id,
        modelID: model.id,
        priced: hasPrice,
        reasoning: model.reasoning === true || model.capabilities?.reasoning === true,
        price: hasPrice ? Math.max(input, 0) + Math.max(output, 0) : Number.POSITIVE_INFINITY,
      };
    });
  const priced = candidates
    .filter((candidate) => candidate.priced)
    .sort((left, right) => Number(left.reasoning) - Number(right.reasoning) || left.price - right.price)[0];
  const selected = priced || candidates.sort((left, right) => Number(left.reasoning) - Number(right.reasoning))[0];
  return selected
    ? { providerID: selected.providerID, modelID: selected.modelID, priced: selected.priced }
    : null;
}

export function filterModelsByProviderCapabilities(models, capabilities) {
  const byProvider = new Map((capabilities || []).map((capability) => [capability.providerId, capability]));
  return models.filter((model) => {
    const capability = byProvider.get(model.providerId);
    if (!capability) return true;
    if (capability.credentials === 'invalid') return false;
    if (capability.credentials === 'valid' && capability.pricedModelAccess === 'unavailable') {
      return model.isFree === true;
    }
    return true;
  });
}

export function addProviderModelCounts(capabilities, models) {
  return (capabilities || []).map((capability) => {
    const providerModels = (models || []).filter((model) => model.providerId === capability.providerId);
    return {
      ...capability,
      modelCount: providerModels.length,
      freeModelCount: providerModels.filter((model) => model.isFree === true).length,
    };
  });
}

export function summarizeReadiness({ models, capabilities, requestedProviders = [] }) {
  const selected = requestedProviders && requestedProviders.length
    ? new Set(requestedProviders)
    : null;
  const scopedCapabilities = selected
    ? (capabilities || []).filter((capability) => selected.has(capability.providerId))
    : (capabilities || []);
  const scopedModels = selected
    ? (models || []).filter((model) => selected.has(model.providerId))
    : (models || []);
  const usableModels = filterModelsByProviderCapabilities(scopedModels, scopedCapabilities);
  return {
    connected_providers: scopedCapabilities.map((capability) => capability.providerId),
    model_count: scopedModels.length,
    usable_model_count: usableModels.length,
    invalid_provider_count: scopedCapabilities.filter((capability) => capability.credentials === 'invalid').length,
    priced_provider_count: scopedCapabilities.filter((capability) => capability.pricedModelAccess === 'available').length,
    free_only_provider_count: scopedCapabilities.filter((capability) => capability.credentials === 'valid' && capability.pricedModelAccess === 'unavailable').length,
  };
}

export function opencodePermissionConfig(permissionMode, cwd = process.cwd()) {
  if (permissionMode === 'full-access') return 'allow';
  const worktreePattern = `${path.resolve(cwd).replaceAll('\\', '/')}/**`;
  const edit = { '*': 'deny', [worktreePattern]: 'allow' };
  if (permissionMode === 'fully-isolated') {
    return {
      '*': 'allow',
      edit,
      bash: 'deny',
      external_directory: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
    };
  }
  return {
    '*': 'allow',
    edit,
    external_directory: 'ask',
  };
}

export function isStructuredOutputTool(toolName) {
  return toolName === 'StructuredOutput';
}

export function permissionResponse(permissionMode, permissionType, toolName) {
  if (permissionMode === 'full-access') return 'once';
  if (permissionType === 'external_directory') {
    if (permissionMode === 'fully-isolated') return 'reject';
    return ['read', 'glob', 'grep', 'skill'].includes(toolName) ? 'once' : 'reject';
  }
  if (permissionMode === 'fully-isolated' && ['webfetch', 'websearch'].includes(permissionType)) {
    return 'reject';
  }
  return 'once';
}

export function opencodeConfigFromEnv(permissionMode, cwd = process.cwd(), env = process.env) {
  const config = {
    permission: opencodePermissionConfig(permissionMode, cwd),
    // OpenCode otherwise auto-connects any provider credential inherited from
    // Agentree's environment. Keep the server scoped to this profile's auth.json.
    enabled_providers: managedOpenCodeProviderIds(env),
  };
  const mcpUrl = String(env.AGENTREE_MCP_URL || env.MCP_SERVER_URL || '').trim();
  if (mcpUrl) {
    config.mcp = {
      agentree: { type: 'remote', url: mcpUrl, enabled: true, oauth: false },
    };
  }
  return config;
}

export function normalizeStructuredOutput(value) {
  if (!value || typeof value !== 'object' || typeof value.final_response !== 'string') return null;
  const optional = (field) => typeof value[field] === 'string' && value[field].trim()
    ? value[field].trim()
    : null;
  return {
    finalResponse: value.final_response,
    commitSubject: optional('commit_subject'),
    commitBody: optional('commit_body'),
    aiLabel: optional('ai_label'),
    threadTitle: optional('thread_title'),
  };
}

export function usageFromAssistantMessage(info) {
  if (!info?.tokens) return null;
  const input = Number(info.tokens.input || 0);
  const output = Number(info.tokens.output || 0);
  const reasoning = Number(info.tokens.reasoning || 0);
  const cached = Number(info.tokens.cache?.read || 0);
  return {
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cached_input_tokens: cached,
    cache_creation_input_tokens: Number(info.tokens.cache?.write || 0),
    total_tokens: input + output + reasoning,
    cost_usd: typeof info.cost === 'number' ? info.cost : null,
  };
}

export function eventSessionId(event) {
  const properties = event?.properties;
  return properties?.sessionID || properties?.part?.sessionID || properties?.info?.sessionID || null;
}

export function isAssistantForPrompt(info, requestMessageID) {
  return info?.role === 'assistant'
    && info.parentID === requestMessageID
    && info.mode !== 'title'
    && info.agent !== 'title';
}

export function isAssistantForPromptSet(info, requestMessageIDs) {
  return info?.role === 'assistant'
    && requestMessageIDs.has(info.parentID)
    && info.mode !== 'title'
    && info.agent !== 'title';
}

export function isPromptSetComplete(turn) {
  return turn.pendingPromptSubmissions === 0
    && turn.requestMessageIDs.size > 0
    && turn.respondedRequestIDs.size === turn.requestMessageIDs.size;
}

export function opencodeErrorMessage(error) {
  const details = opencodeErrorDetails(error);
  if (!details) return null;
  return details.statusCode ? `${details.message} (HTTP ${details.statusCode})` : details.message;
}

export function opencodeErrorDetails(error) {
  if (!error) return null;
  if (typeof error === 'string') {
    return { name: null, message: error, statusCode: null, providerMessage: null };
  }
  const data = error.data && typeof error.data === 'object' ? error.data : {};
  let providerMessage = null;
  if (typeof data.responseBody === 'string') {
    try {
      const body = JSON.parse(data.responseBody);
      providerMessage = typeof body?.error?.message === 'string' ? body.error.message : null;
    } catch { /* Only structured provider messages are safe to expose. */ }
  }
  return {
    name: typeof error.name === 'string' ? error.name : null,
    message: error.message || data.message || error.name || 'OpenCode provider error',
    statusCode: Number.isInteger(data.statusCode) ? data.statusCode : null,
    providerMessage,
  };
}

export function structuredOutputRecovery({ error, finalText, usage, toolActivity }) {
  const details = opencodeErrorDetails(error);
  if (!details) return null;
  if (details.name === 'StructuredOutputError' && String(finalText || '').trim()) return 'use_text';
  const totalTokens = Number(usage?.total_tokens || 0);
  if (
    details.name === 'APIError'
    && details.statusCode === 400
    && !String(finalText || '').trim()
    && !toolActivity
    && totalTokens === 0
  ) return 'retry_plain';
  return null;
}

function normalizeModelCatalogForScope(catalog, connectedOnly) {
  const connected = new Set(Array.isArray(catalog?.connected) ? catalog.connected : []);
  const modalities = (value) => {
    if (Array.isArray(value)) return value.filter((kind) => typeof kind === 'string');
    return Object.entries(value || {}).filter(([, enabled]) => enabled === true).map(([kind]) => kind);
  };
  const statusRank = { active: 0, beta: 1, alpha: 2, deprecated: 3 };
  return (Array.isArray(catalog?.all) ? catalog.all : [])
    .filter((provider) => !connectedOnly || connected.has(provider.id))
    .flatMap((provider) => Object.values(provider.models || {}).map((model) => {
      const capabilities = model.capabilities || {};
      const input = capabilities.input || model.modalities?.input || {};
      const output = capabilities.output || model.modalities?.output || {};
      const cost = model.cost && typeof model.cost === 'object' ? model.cost : null;
      const explicitCosts = cost
        ? [cost.input, cost.output, cost.cache_read, cost.cache_write, cost.cache?.read, cost.cache?.write]
          .filter((value) => typeof value === 'number')
        : [];
      const zeroCost = cost && typeof cost.input === 'number' && typeof cost.output === 'number'
        ? explicitCosts.every((value) => value === 0)
        : null;
      const modelId = String(model.id || '').toLowerCase();
      return {
        id: `${provider.id}/${model.id}`,
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        name: model.name || model.id,
        description: typeof model.description === 'string' ? model.description : '',
        reasoning: capabilities.reasoning === true || model.reasoning === true,
        attachment: capabilities.attachment === true || model.attachment === true,
        toolCall: capabilities.toolcall === true || model.tool_call === true,
        inputModalities: modalities(input),
        outputModalities: modalities(output),
        variants: Object.keys(model.variants || {}),
        contextWindow: model.limit?.context || null,
        maxOutputTokens: model.limit?.output || null,
        releaseDate: typeof model.release_date === 'string' ? model.release_date : null,
        status: typeof model.status === 'string' ? model.status : null,
        isFree: zeroCost === null ? null : zeroCost && (
          provider.id === 'opencode'
          || (provider.id === 'openrouter' && (modelId.endsWith(':free') || modelId === 'openrouter/free'))
        ),
      };
    }))
    .sort((left, right) => {
      const leftStatus = statusRank[left.status] ?? 0;
      const rightStatus = statusRank[right.status] ?? 0;
      if (leftStatus !== rightStatus) return leftStatus - rightStatus;
      const releaseOrder = String(right.releaseDate || '').localeCompare(String(left.releaseDate || ''));
      if (releaseOrder !== 0) return releaseOrder;
      return left.name.localeCompare(right.name) || left.providerName.localeCompare(right.providerName);
    });
}

export function normalizeModelCatalog(catalog) {
  return normalizeModelCatalogForScope(catalog, true);
}

export function normalizeSupportedModelCatalog(catalog) {
  return normalizeModelCatalogForScope(catalog, false);
}

export function toOpenCodeCatalogRecords(models, sourceVersion, checkedAt = nowMs()) {
  return models.map((model) => ({
    ...model,
    provider: 'opencode',
    canonicalModelId: model.id,
    cliModelId: model.id,
    upstreamProviderId: model.providerId,
    supportedReasoningEfforts: model.variants,
    defaultReasoningEffort: null,
    hidden: false,
    isDefault: null,
    sourceVersion: sourceVersion || null,
    checkedAt,
  }));
}

function parseArgs(argv) {
  const parsed = {
    prompt: '',
    model: null,
    variant: null,
    permissionMode: 'full-access',
    providerThreadId: null,
    providerTurnId: null,
    sourceProviderThreadId: null,
    targetProviderTurnId: null,
    sourceProviderLineageId: null,
    providerThreadStrategy: 'fresh_thread',
    nodeId: null,
    targetNodeId: null,
    inputArtifacts: [],
    opencodeBin: process.env.AGENTREE_OPENCODE_BIN || 'opencode',
    readinessCheck: false,
    listModels: false,
    listSupportedModels: false,
    providers: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const take = () => { index += 1; return next ?? null; };
    switch (arg) {
      case '--model': parsed.model = take(); break;
      case '--variant':
      case '--reasoning-effort': parsed.variant = take(); break;
      case '--permission-mode': parsed.permissionMode = take() || 'full-access'; break;
      case '--provider-thread-id': parsed.providerThreadId = take(); break;
      case '--provider-turn-id': parsed.providerTurnId = take(); break;
      case '--source-provider-thread-id': parsed.sourceProviderThreadId = take(); break;
      case '--target-provider-turn-id': parsed.targetProviderTurnId = take(); break;
      case '--source-provider-lineage-id': parsed.sourceProviderLineageId = take(); break;
      case '--provider-thread-strategy': parsed.providerThreadStrategy = take() || 'fresh_thread'; break;
      case '--node-id': parsed.nodeId = take(); break;
      case '--target-node-id': parsed.targetNodeId = take(); break;
      case '--opencode-bin': parsed.opencodeBin = take() || parsed.opencodeBin; break;
      case '--input-artifacts-json': {
        const raw = take();
        try { parsed.inputArtifacts = raw ? JSON.parse(raw) : []; } catch { parsed.inputArtifacts = []; }
        break;
      }
      case '--readiness-check': parsed.readinessCheck = true; break;
      case '--providers': {
        const raw = take();
        parsed.providers = raw
          ? raw.split(',').map((value) => value.trim()).filter(Boolean)
          : [];
        break;
      }
      case '--list-models': parsed.listModels = true; break;
      case '--list-supported-models': parsed.listSupportedModels = true; break;
      case '--print':
      case '--verbose':
      case '--no-session-persistence':
      case '--strict-mcp-config':
        break;
      case '--output-format': index += 1; break;
      case '-p':
      case '--prompt': parsed.prompt = take() || ''; break;
      default:
        if (!arg.startsWith('--')) parsed.prompt = arg;
    }
  }
  return parsed;
}

function artifactParts(artifacts) {
  return artifacts.flatMap((artifact) => {
    const storage = artifact?.storage;
    const location = storage?.path || storage?.url;
    if (!location) return [];
    const url = storage.path ? pathToFileURL(path.resolve(storage.path)).href : location;
    return [{
      type: 'file',
      mime: artifact.mimeType || 'application/octet-stream',
      filename: artifact.filename || artifact.title || undefined,
      url,
    }];
  });
}

export function artifactStorage(url) {
  if (url.startsWith('data:')) return { backend: 'inline', url };
  if (url.startsWith('file:')) return { backend: 'local', path: fileURLToPath(url) };
  return { backend: 'remote', url };
}

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function availableLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(args) {
  const password = crypto.randomBytes(24).toString('base64url');
  const config = opencodeConfigFromEnv(args.permissionMode);
  const port = await availableLoopbackPort();
  if (!port) throw new Error('Could not allocate an OpenCode server port.');
  const child = spawn(args.opencodeBin, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: [path.dirname(args.opencodeBin), process.env.PATH].filter(Boolean).join(path.delimiter),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_SERVER_USERNAME: 'agentree',
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out waiting for OpenCode server. ${output.trim()}`));
    }, SERVER_START_TIMEOUT_MS);
    const inspect = (chunk) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening[^\n]*on\s+(https?:\/\/[^\s]+)/i);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`OpenCode server exited with ${code}. ${output.trim()}`));
    });
  });
  const authorization = basicAuthHeader('agentree', password);
  const client = createOpencodeClient({
    baseUrl: url,
    directory: process.cwd(),
    headers: { Authorization: authorization },
    throwOnError: true,
  });
  return { child, client, url, authorization };
}

async function terminateServer(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 2_000);
      timeout.unref();
    }),
  ]);
  if (graceful) return;
  child.kill('SIGKILL');
  await exited;
}

export async function resolveSession(client, args) {
  const requested = ['fresh_thread', 'resume', 'fork_at_turn'].includes(args.providerThreadStrategy)
    ? args.providerThreadStrategy
    : 'fresh_thread';
  const sourceThreadId = args.sourceProviderThreadId || args.providerThreadId || null;
  if (requested === 'resume') {
    if (!sourceThreadId) throw new Error('OpenCode resume requires a provider thread id.');
    return { sessionID: sourceThreadId, strategy: 'resume', sourceThreadId };
  }
  if (requested === 'fork_at_turn') {
    const messageID = args.targetProviderTurnId || args.providerTurnId;
    if (!sourceThreadId || !messageID) {
      throw new Error('OpenCode exact branching requires provider thread and turn ids.');
    }
    const forked = await client.session.fork({
      path: { id: sourceThreadId },
      body: { messageID },
    });
    return { sessionID: forked.data.id, strategy: 'fork_at_turn', sourceThreadId };
  }
  const created = await client.session.create({ body: {} });
  return { sessionID: created.data.id, strategy: 'fresh_thread', sourceThreadId: null };
}

async function providerCatalog(client) {
  const response = await client.provider.list();
  return response.data;
}

async function probeProviderCapability(client, provider, direct) {
  const selected = chooseProviderProbeModel(provider);
  if (!selected) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      credentials: direct?.credentials || 'unknown',
      pricedModelAccess: direct?.pricedModelAccess || 'unknown',
      checkedAt: nowMs(),
      method: direct?.method || 'no_probe_model',
    };
  }
  let sessionID = null;
  let classification = await directInferenceProbe(selected);
  let probeMethod = 'direct_inference';
  if (!classification) {
    probeMethod = 'inference';
    try {
      const session = await client.session.create({ body: {}, signal: AbortSignal.timeout(12_000) });
      sessionID = session.data.id;
      const response = await client.session.prompt({
        path: { id: sessionID },
        body: {
          model: { providerID: selected.providerID, modelID: selected.modelID },
          system: 'Return exactly one word: OK.',
          tools: { bash: false, edit: false, read: false, task: false, webfetch: false, websearch: false },
          parts: [{ type: 'text', text: 'OK' }],
        },
        signal: AbortSignal.timeout(12_000),
      });
      classification = classifyProviderProbe(response.data?.info?.error || null);
    } catch (error) {
      classification = classifyProviderProbe(error);
    } finally {
      if (sessionID) {
        try {
          await client.session.delete({ path: { id: sessionID }, signal: AbortSignal.timeout(3_000) });
        } catch { /* Probe sessions are disposable. */ }
      }
    }
  }
  if (!selected.priced && classification.pricedModelAccess === 'available') {
    classification.pricedModelAccess = 'unavailable';
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    credentials: classification.credentials === 'unknown'
      ? direct?.credentials || 'unknown'
      : classification.credentials,
    pricedModelAccess: classification.pricedModelAccess === 'unknown'
      ? direct?.pricedModelAccess || 'unknown'
      : classification.pricedModelAccess,
    checkedAt: nowMs(),
    method: direct ? `${direct.method}+${probeMethod}` : probeMethod,
    probeModel: `${selected.providerID}/${selected.modelID}`,
  };
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

export function selectProbeProviders(catalog, requested = []) {
  const connected = new Set(catalog.connected || []);
  const selected = requested && requested.length ? new Set(requested) : null;
  return (catalog.all || []).filter((provider) => (
    connected.has(provider.id) && (!selected || selected.has(provider.id))
  ));
}

async function checkProviderCapabilities(client, catalog, requested = []) {
  const providers = selectProbeProviders(catalog, requested);
  return mapWithConcurrency(providers, 3, async (provider) => {
    const direct = await directProviderCapability(provider.id);
    if (
      direct?.credentials === 'invalid'
      || direct?.pricedModelAccess === 'available'
      || direct?.pricedModelAccess === 'unavailable'
    ) {
      return { ...direct, providerName: provider.name };
    }
    return probeProviderCapability(client, provider, direct);
  });
}

async function inspectRuntime(args) {
  const server = await startServer(args);
  try {
    const [healthResponse, providers] = await Promise.all([
      fetch(`${server.url}/global/health`, { headers: { Authorization: server.authorization } }),
      providerCatalog(server.client),
    ]);
    if (!healthResponse.ok) throw new Error(`OpenCode health check failed with HTTP ${healthResponse.status}.`);
    const health = await healthResponse.json();
    const checkedAt = nowMs();
    const normalizedModels = args.listSupportedModels
      ? normalizeSupportedModelCatalog(providers)
      : normalizeModelCatalog(providers);
    const models = toOpenCodeCatalogRecords(normalizedModels, health.version, checkedAt);
    emit({
      type: 'model_catalog',
      provider: 'opencode',
      catalogScope: args.listSupportedModels ? 'supported' : 'accessible',
      sourceVersion: health.version,
      checkedAt,
      models,
    });
    if (!args.listModels && !args.listSupportedModels) {
      const capabilities = addProviderModelCounts(
        await checkProviderCapabilities(server.client, providers, args.providers),
        models,
      );
      const readiness = summarizeReadiness({ models, capabilities, requestedProviders: args.providers });
      emit({ type: 'provider_capabilities', provider: 'opencode', capabilities });
      emit({
        type: 'readiness',
        provider: 'opencode',
        status: 'ready',
        cli_path: args.opencodeBin,
        cli_version: health.version,
        ...readiness,
      });
    }
    return 0;
  } finally {
    await terminateServer(server.child);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.readinessCheck || args.listModels || args.listSupportedModels) return inspectRuntime(args);
  if (!args.model) throw new Error('An OpenCode model is required.');
  const model = parseOpenCodeModel(args.model);
  const server = await startServer(args);
  const { client } = server;
  let activeSessionID = null;
  let lastAssistantID = null;
  let lastUsage = null;
  let lastFinalText = '';
  let activeTurn = null;
  const toolStates = new Map();
  const toolNamesByCallID = new Map();
  const eventAbort = new AbortController();

  const stopServer = async () => {
    eventAbort.abort();
    await terminateServer(server.child);
  };
  const abortRun = async () => {
    if (activeSessionID) {
      try { await client.session.abort({ path: { id: activeSessionID } }); } catch { /* process cleanup follows */ }
    }
    await stopServer();
  };
  process.once('SIGTERM', () => void abortRun());
  process.once('SIGINT', () => void abortRun());

  const controlReader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  controlReader.on('line', (line) => {
    let control;
    try { control = JSON.parse(line); } catch { return; }
    if (control.type !== 'steer_agent_run' && control.control_type !== 'steer') return;
    const content = typeof control.content === 'string' ? control.content.trim() : '';
    if (!content || !activeSessionID || !activeTurn) return;
    const requestMessageID = `msg_agentree_steer_${crypto.randomUUID().replaceAll('-', '')}`;
    const turn = activeTurn;
    turn.requestMessageIDs.add(requestMessageID);
    turn.requestOrder.push(requestMessageID);
    turn.pendingPromptSubmissions += 1;
    void client.session.promptAsync({
      path: { id: activeSessionID },
      body: {
        messageID: requestMessageID,
        model,
        variant: args.variant || undefined,
        parts: [{ type: 'text', text: content }],
      },
    }).then(() => {
      turn.pendingPromptSubmissions -= 1;
      emit({
        type: 'provider_steer_ack',
        idempotency_key: control.idempotency_key ?? null,
        provider_thread_id: activeSessionID,
        provider_turn_id: lastAssistantID,
        provider_steer_delivery: 'queue',
        timestamp: nowMs(),
      });
    }).catch((error) => {
      turn.pendingPromptSubmissions -= 1;
      turn.requestMessageIDs.delete(requestMessageID);
      turn.requestOrder = turn.requestOrder.filter((id) => id !== requestMessageID);
      emit({
        type: 'provider_steer_failed',
        idempotency_key: control.idempotency_key ?? null,
        error: error?.message || String(error),
        timestamp: nowMs(),
      });
    });
  });

  try {
    const session = await resolveSession(client, args);
    activeSessionID = session.sessionID;
    const lineageID = args.sourceProviderLineageId || session.sourceThreadId || activeSessionID;
    emit({ type: 'session', session_id: activeSessionID, provider: 'opencode', transport: 'opencode_server' });
    emit({
      type: 'provider_meta',
      meta: {
        provider: 'opencode',
        transport: 'opencode_server_sdk',
        provider_thread_id: activeSessionID,
        provider_thread_strategy: session.strategy,
        provider_source_thread_id: session.sourceThreadId,
        provider_target_turn_id: args.targetProviderTurnId || null,
        provider_lineage_id: lineageID,
        provider_model: args.model,
        opencode_model_provider: model.providerID,
        provider_reasoning_effort: args.variant,
        provider_run_mode: args.permissionMode,
        provider_steer_delivery: 'queue',
      },
    });

    const parts = [{ type: 'text', text: args.prompt }, ...artifactParts(args.inputArtifacts)];
    const runPrompt = async (body) => {
      const requestMessageID = `msg_agentree_${crypto.randomUUID().replaceAll('-', '')}`;
      const turn = {
        assistantMessageIDs: new Set(),
        assistantRequestIDs: new Map(),
        requestMessageIDs: new Set([requestMessageID]),
        requestOrder: [requestMessageID],
        respondedRequestIDs: new Set(),
        pendingPromptSubmissions: 0,
        latestRequestMessageID: requestMessageID,
        completed: false,
        error: null,
        finalText: '',
        partText: new Map(),
        structuredFinal: null,
        toolActivity: false,
        usage: null,
      };
      let promptAccepted = false;
      const subscription = await client.event.subscribe({ signal: eventAbort.signal });
      const eventLoop = (async () => {
        for await (const event of subscription.stream) {
          if (eventSessionId(event) !== activeSessionID) continue;
          if (event.type === 'message.part.updated') {
            const { part, delta } = event.properties;
            if (!turn.assistantMessageIDs.has(part.messageID)) continue;
            const isLatestResponse = turn.assistantRequestIDs.get(part.messageID) === turn.latestRequestMessageID;
            if (part.type === 'text') {
              if (isLatestResponse) turn.partText.set(part.id, part.text || '');
              if (delta) emit({ type: 'message_delta', content: delta, provider_item_id: part.id, timestamp: nowMs() });
              if (isLatestResponse && part.time?.end) turn.finalText = part.text || turn.finalText;
            } else if (part.type === 'reasoning') {
              if (delta) emit({ type: 'thinking', content: delta, is_delta: true, provider_item_id: part.id, timestamp: nowMs() });
            } else if (part.type === 'tool') {
              turn.toolActivity = true;
              const previous = toolStates.get(part.id);
              const state = part.state;
              toolStates.set(part.id, state.status);
              toolNamesByCallID.set(part.callID, part.tool);
              // The StructuredOutput tool is the internal delivery channel for
              // structured results. It must not surface in the execution timeline
              // (same treatment as the Claude adapter's isStructuredOutputBlock).
              if (isStructuredOutputTool(part.tool)) continue;
              if ((state.status === 'pending' || state.status === 'running') && previous !== state.status) {
                emit({
                  type: 'tool_use',
                  toolName: part.tool,
                  toolUseId: part.callID,
                  input: state.input,
                  tool_input: state.input,
                  provider_item_id: part.id,
                  timestamp: nowMs(),
                });
              }
              if (state.status === 'completed' && previous !== 'completed') {
                emit({ type: 'tool_result', toolName: part.tool, toolUseId: part.callID, toolOutput: state.output, is_error: false, provider_item_id: part.id, timestamp: nowMs() });
              }
              if (state.status === 'error' && previous !== 'error') {
                emit({ type: 'tool_result', toolName: part.tool, toolUseId: part.callID, toolOutput: state.error, is_error: true, provider_item_id: part.id, timestamp: nowMs() });
              }
            } else if (part.type === 'file') {
              emit({
                type: 'artifact_registered',
                artifact: {
                  id: part.id,
                  nodeId: args.nodeId || args.targetNodeId || activeSessionID,
                  role: 'output',
                  kind: 'file',
                  mimeType: part.mime,
                  title: part.filename || 'OpenCode output',
                  filename: part.filename,
                  storage: artifactStorage(part.url),
                },
                timestamp: nowMs(),
              });
            }
            continue;
          }
          if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
            const info = event.properties.info;
            if (!isAssistantForPromptSet(info, turn.requestMessageIDs)) continue;
            const latestRequestIndex = turn.requestOrder.indexOf(turn.latestRequestMessageID);
            const requestIndex = turn.requestOrder.indexOf(info.parentID);
            if (requestIndex > latestRequestIndex) {
              turn.latestRequestMessageID = info.parentID;
              turn.finalText = '';
              turn.partText.clear();
              turn.structuredFinal = null;
              turn.error = null;
            }
            turn.respondedRequestIDs.add(info.parentID);
            turn.assistantMessageIDs.add(info.id);
            turn.assistantRequestIDs.set(info.id, info.parentID);
            const isLatestResponse = info.parentID === turn.latestRequestMessageID;
            if (isLatestResponse) {
              lastAssistantID = info.id;
              turn.usage = usageFromAssistantMessage(info) || turn.usage;
              lastUsage = turn.usage || lastUsage;
              turn.structuredFinal = normalizeStructuredOutput(info.structured ?? info.structured_output) || turn.structuredFinal;
            }
            if (turn.usage) emit({ type: 'usage', usage: turn.usage, timestamp: nowMs() });
            emit({ type: 'provider_meta', meta: { provider_thread_id: activeSessionID, provider_turn_id: info.id, provider_model: `${info.providerID}/${info.modelID}`, opencode_finish: info.finish || null, opencode_cost_usd: info.cost ?? null }, timestamp: nowMs() });
            if (isLatestResponse && info.error) turn.error = info.error;
            continue;
          }
          if (event.type === 'permission.updated') {
            const permission = event.properties;
            await client.postSessionIdPermissionsPermissionId({
              path: { id: activeSessionID, permissionID: permission.id },
              body: {
                response: permissionResponse(
                  args.permissionMode,
                  permission.type,
                  permission.callID ? toolNamesByCallID.get(permission.callID) : undefined,
                ),
              },
            });
            continue;
          }
          if (event.type === 'session.error') {
            if (turn.assistantMessageIDs.size > 0) turn.error = event.properties.error || turn.error;
            continue;
          }
          if (
            (event.type === 'session.idle' || (event.type === 'session.status' && event.properties.status.type === 'idle'))
            && promptAccepted
            && isPromptSetComplete(turn)
          ) {
            turn.completed = true;
            if (activeTurn === turn) activeTurn = null;
            break;
          }
        }
      })();
      // Do not accept steering until the subscription is live. Otherwise a
      // fast queued prompt can start before we can observe its events.
      activeTurn = turn;
      promptAccepted = true;
      await client.session.promptAsync({
        path: { id: activeSessionID },
        body: { ...body, messageID: requestMessageID },
      });
      await eventLoop;
      if (activeTurn === turn) activeTurn = null;
      turn.finalText = turn.structuredFinal?.finalResponse
        || turn.finalText
        || Array.from(turn.partText.values()).at(-1)
        || '';
      return turn;
    };

    const structuredBody = {
      model,
      variant: args.variant || undefined,
      parts,
      format: { type: 'json_schema', schema: FINAL_RESULT_SCHEMA, retryCount: 2 },
    };
    let turn = await runPrompt(structuredBody);
    const recovery = structuredOutputRecovery({
      error: turn.error,
      finalText: turn.finalText,
      usage: turn.usage,
      toolActivity: turn.toolActivity,
    });
    let structuredOutputFailed = false;
    if (recovery) {
      structuredOutputFailed = true;
      const details = opencodeErrorDetails(turn.error);
      emit({
        type: 'provider_meta',
        meta: {
          structured_output_failed: true,
          structured_output_retry_count: recovery === 'retry_plain' ? 1 : 0,
          structured_output_error: details?.message || 'OpenCode structured output failed',
          provider_error_status: details?.statusCode,
        },
        timestamp: nowMs(),
      });
      if (recovery === 'retry_plain') {
        turn = await runPrompt({ model, variant: args.variant || undefined, parts });
      } else {
        turn.error = null;
      }
    }

    const finalText = turn.finalText;
    const structuredFinal = turn.structuredFinal;
    lastFinalText = finalText;
    if (finalText) emit({ type: 'message_completed', content: finalText, provider_thread_id: activeSessionID, provider_item_id: lastAssistantID, timestamp: nowMs() });
    if (structuredFinal) {
      emit({
        type: 'provider_meta',
        meta: {
          commit_subject: structuredFinal.commitSubject,
          commit_body: structuredFinal.commitBody,
          ai_label: structuredFinal.aiLabel,
          thread_title: structuredFinal.threadTitle,
        },
        timestamp: nowMs(),
      });
    }
    const errorDetails = opencodeErrorDetails(turn.error);
    const lastError = opencodeErrorMessage(turn.error);
    if (lastError) {
      emit({ type: 'error', content: lastError, timestamp: nowMs() });
      emit({
        type: 'provider_meta',
        meta: {
          provider_error_code: errorDetails?.name,
          provider_error_status: errorDetails?.statusCode,
          provider_error_message: errorDetails?.providerMessage || errorDetails?.message,
        },
        timestamp: nowMs(),
      });
    }
    emit({
      type: 'provider_stop',
      provider_stop_reason: lastError
        ? 'provider_error'
        : structuredOutputFailed
          ? 'structured_output_failed'
          : turn.completed ? 'end_turn' : 'stream_ended',
      provider_status: lastError ? 'failed' : 'completed',
      final_content: finalText || lastError || '',
      provider_thread_id: activeSessionID,
      provider_turn_id: lastAssistantID,
      provider_item_id: lastAssistantID,
      usage: lastUsage,
      timestamp: nowMs(),
    });
    return lastError ? 1 : 0;
  } catch (error) {
    const content = `OpenCode adapter failed: ${opencodeErrorMessage(error) || String(error)}`;
    emit({ type: 'error', content, timestamp: nowMs() });
    emit({ type: 'provider_stop', provider_stop_reason: 'error', provider_status: 'failed', final_content: lastFinalText || content, provider_thread_id: activeSessionID, provider_turn_id: lastAssistantID, usage: lastUsage, timestamp: nowMs() });
    return 1;
  } finally {
    controlReader.close();
    await stopServer();
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (error) {
    emit({ type: 'error', content: `OpenCode adapter failed: ${error?.message || String(error)}`, timestamp: nowMs() });
    process.exitCode = 1;
  }
}
