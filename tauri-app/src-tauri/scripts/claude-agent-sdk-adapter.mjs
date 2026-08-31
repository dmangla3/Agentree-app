#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';

const FINAL_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['final_response', 'commit_subject', 'ai_label', 'thread_title'],
  properties: {
    final_response: {
      type: 'string',
      description: 'User-visible final assistant response. Keep the normal summary, verification, and caveats here.',
    },
    commit_subject: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Concise imperative git commit subject for the changes made, 4-10 words, no trailing period. Use null if no files changed.',
    },
    ai_label: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Concise 5-10 word graph label for this assistant message. Describe the outcome, not the full response. No trailing period.',
    },
    thread_title: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Concise 3-7 word title for the Agentree thread, based only on the first user request. Use null unless Agentree explicitly says this is the first user message in a new thread.',
    },
  },
};

function nowMs() {
  return Date.now();
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitTrace(name, detail = undefined) {
  emit({
    type: 'trace',
    name,
    source: 'claude_agent_sdk_adapter',
    ts: nowMs(),
    ...(detail ? { detail } : {}),
  });
}

function providerThreadReuseMessage(provider, action, reason) {
  return `${provider} could not ${action} the provider thread. ${reason}`;
}

function hasEnvValue(name) {
  return Boolean((process.env[name] ?? '').trim());
}

export function hasAgentreeManagedClaudeCredential() {
  return Boolean(
    hasEnvValue('ANTHROPIC_API_KEY')
    || hasEnvValue('ANTHROPIC_AUTH_TOKEN')
    || hasEnvValue('ANTHROPIC_BASE_URL')
    || hasEnvValue('ANTHROPIC_BEDROCK_BASE_URL')
    || hasEnvValue('ANTHROPIC_VERTEX_BASE_URL')
    || hasEnvValue('ANTHROPIC_FOUNDRY_BASE_URL')
    || hasEnvValue('CLAUDE_CODE_USE_BEDROCK')
    || hasEnvValue('CLAUDE_CODE_USE_VERTEX')
    || hasEnvValue('CLAUDE_CODE_USE_FOUNDRY')
    || hasEnvValue('CLAUDE_CODE_USE_ANTHROPIC_AWS')
  );
}

function parseClaudeAuthStatus(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    return null;
  }
  return null;
}

export function probeClaudeAuth() {
  if (hasAgentreeManagedClaudeCredential()) {
    emitTrace('claude_environment', {
      auth_method: 'agentree_managed',
      has_ANTHROPIC_API_KEY: hasEnvValue('ANTHROPIC_API_KEY'),
      has_ANTHROPIC_AUTH_TOKEN: hasEnvValue('ANTHROPIC_AUTH_TOKEN'),
      has_ANTHROPIC_BASE_URL: hasEnvValue('ANTHROPIC_BASE_URL'),
      has_ANTHROPIC_BEDROCK_BASE_URL: hasEnvValue('ANTHROPIC_BEDROCK_BASE_URL'),
      has_ANTHROPIC_VERTEX_BASE_URL: hasEnvValue('ANTHROPIC_VERTEX_BASE_URL'),
      has_ANTHROPIC_FOUNDRY_BASE_URL: hasEnvValue('ANTHROPIC_FOUNDRY_BASE_URL'),
      has_CLAUDE_CODE_USE_BEDROCK: hasEnvValue('CLAUDE_CODE_USE_BEDROCK'),
      has_CLAUDE_CODE_USE_VERTEX: hasEnvValue('CLAUDE_CODE_USE_VERTEX'),
      has_CLAUDE_CODE_USE_FOUNDRY: hasEnvValue('CLAUDE_CODE_USE_FOUNDRY'),
      has_CLAUDE_CODE_USE_ANTHROPIC_AWS: hasEnvValue('CLAUDE_CODE_USE_ANTHROPIC_AWS'),
    });
    return null;
  }

  const result = spawnSync('claude', ['auth', 'status'], {
    encoding: 'utf8',
    env: process.env,
  });
  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  const parsed = parseClaudeAuthStatus(stdout);
  const loggedIn = typeof parsed?.loggedIn === 'boolean'
    ? parsed.loggedIn
    : result.status === 0;

  emitTrace('claude_environment', {
    has_ANTHROPIC_API_KEY: hasEnvValue('ANTHROPIC_API_KEY'),
    has_ANTHROPIC_AUTH_TOKEN: hasEnvValue('ANTHROPIC_AUTH_TOKEN'),
    claude_auth_status_exit_code: result.status,
    claude_auth_logged_in: loggedIn,
    claude_auth_method: typeof parsed?.authMethod === 'string' ? parsed.authMethod : null,
  });

  if (result.error) {
    return `Claude Code authentication could not be checked: ${result.error.message}`;
  }
  if (!loggedIn) {
    if (parsed) {
      return 'Claude Code is not authenticated. Run `claude auth login` in a terminal, then retry from Agentree.';
    }
    return stderr || stdout || 'Claude Code is not authenticated. Run `claude auth login` in a terminal, then retry from Agentree.';
  }
  return null;
}

function parseArgs(argv) {
  const parsed = {
    prompt: '',
    model: null,
    effort: null,
    permissionMode: null,
    sessionId: null,
    mcpServers: null,
    providerThreadId: null,
    providerTurnId: null,
    sourceProviderThreadId: null,
    targetProviderTurnId: null,
    sourceProviderLineageId: null,
    providerThreadStrategy: 'fresh_thread',
    nodeId: null,
    targetNodeId: null,
    denyTools: false,
    unknown: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--model':
        parsed.model = next ?? null;
        index += 1;
        break;
      case '--effort':
        parsed.effort = next ?? null;
        index += 1;
        break;
      case '--permission-mode':
        parsed.permissionMode = next ?? null;
        index += 1;
        break;
      case '--session-id':
        parsed.sessionId = next ?? null;
        index += 1;
        break;
      case '--mcp-config':
        if (next) {
          try {
            const config = JSON.parse(next);
            parsed.mcpServers = config.mcpServers ?? null;
          } catch (error) {
            emit({ type: 'error', content: `Invalid --mcp-config JSON: ${error.message}`, timestamp: nowMs() });
          }
        }
        index += 1;
        break;
      case '--provider-thread-id':
        parsed.providerThreadId = next ?? null;
        index += 1;
        break;
      case '--provider-turn-id':
        parsed.providerTurnId = next ?? null;
        index += 1;
        break;
      case '--source-provider-thread-id':
        parsed.sourceProviderThreadId = next ?? null;
        index += 1;
        break;
      case '--target-provider-turn-id':
        parsed.targetProviderTurnId = next ?? null;
        index += 1;
        break;
      case '--source-provider-lineage-id':
        parsed.sourceProviderLineageId = next ?? null;
        index += 1;
        break;
      case '--provider-thread-strategy':
        parsed.providerThreadStrategy = (next ?? 'fresh_thread').trim() || 'fresh_thread';
        index += 1;
        break;
      case '--node-id':
        parsed.nodeId = next ?? null;
        index += 1;
        break;
      case '--target-node-id':
        parsed.targetNodeId = next ?? null;
        index += 1;
        break;
      case '--deny-tools':
        parsed.denyTools = true;
        break;
      case '--print':
      case '--verbose':
      case '--no-session-persistence':
      case '--strict-mcp-config':
        break;
      case '--output-format':
      case '-p':
      case '--prompt':
        if (arg === '--output-format') {
          index += 1;
        } else {
          parsed.prompt = next ?? '';
          index += 1;
        }
        break;
      default:
        if (arg.startsWith('--')) {
          parsed.unknown.push(arg);
          if (next && !next.startsWith('--')) {
            parsed.unknown.push(next);
            index += 1;
          }
        } else {
          parsed.prompt = arg;
        }
    }
  }

  return parsed;
}

function textFromContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textFromContent).join('');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return textFromContent(value.content);
    if (Array.isArray(value.output)) return textFromContent(value.output);
    if (typeof value.message === 'string') return value.message;
  }
  return '';
}

function extractAssistantText(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function extractToolResults(message, ignoredToolUseIds = new Set()) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => {
      if (block?.type !== 'tool_result') return false;
      if (isStructuredOutputBlock(block)) return false;
      const toolUseId = block.tool_use_id ?? block.id ?? null;
      return !(toolUseId && ignoredToolUseIds.has(toolUseId));
    })
    .map((block) => ({
      type: 'tool_result',
      toolName: block.name ?? block.tool_name ?? 'tool',
      toolUseId: block.tool_use_id ?? block.id ?? null,
      toolOutput: block.content ?? block.output ?? null,
      is_error: block.is_error === true,
      timestamp: nowMs(),
    }));
}

function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? null;
  const outputTokens = usage.output_tokens ?? usage.outputTokens ?? null;
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? null;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? null;
  const totalTokens =
    usage.total_tokens ??
    usage.totalTokens ??
    (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    total_tokens: totalTokens,
  };
}

function mapRateLimitInfo(rateLimitInfo) {
  if (!rateLimitInfo || typeof rateLimitInfo !== 'object') return null;
  return {
    kind: 'claude',
    bucket: {
      isUsingOverage: typeof rateLimitInfo.isUsingOverage === 'boolean' ? rateLimitInfo.isUsingOverage : null,
      overageDisabledReason: typeof rateLimitInfo.overageDisabledReason === 'string' ? rateLimitInfo.overageDisabledReason : null,
      overageResetsAt: typeof rateLimitInfo.overageResetsAt === 'number' ? rateLimitInfo.overageResetsAt : null,
      overageStatus: typeof rateLimitInfo.overageStatus === 'string' ? rateLimitInfo.overageStatus : null,
      rateLimitType: typeof rateLimitInfo.rateLimitType === 'string' ? rateLimitInfo.rateLimitType : null,
      resetsAt: typeof rateLimitInfo.resetsAt === 'number' ? rateLimitInfo.resetsAt : null,
      status: typeof rateLimitInfo.status === 'string' ? rateLimitInfo.status : null,
      surpassedThreshold: typeof rateLimitInfo.surpassedThreshold === 'number' ? rateLimitInfo.surpassedThreshold : null,
      utilization: typeof rateLimitInfo.utilization === 'number' ? rateLimitInfo.utilization : null,
    },
  };
}

function normalizeStructuredCommitSubject(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`\-\s]+|["'`\s.]+$/g, '');
  if (!normalized) return null;
  return normalized.slice(0, 72).trim() || null;
}

function normalizeStructuredAiLabel(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`+/g, '')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`\-\s]+|["'`\s.]+$/g, '');
  if (!normalized) return null;
  return normalized.slice(0, 80).trim() || null;
}

function normalizeStructuredThreadTitle(value) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/`+/g, '')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`\-\s]+|["'`\s.]+$/g, '');
  if (!normalized) return null;
  return normalized.slice(0, 80).trim() || null;
}

function normalizeStructuredFinalResponse(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isStructuredOutputBlock(block) {
  return block?.name === 'StructuredOutput';
}

function structuredFinalOutputFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  const finalResponse = normalizeStructuredFinalResponse(input.final_response);
  const commitSubject = normalizeStructuredCommitSubject(input.commit_subject);
  const aiLabel = normalizeStructuredAiLabel(input.ai_label);
  const threadTitle = normalizeStructuredThreadTitle(input.thread_title);
  if (!finalResponse && !commitSubject && !aiLabel && !threadTitle) return null;
  return {
    finalResponse,
    commitSubject,
    aiLabel,
    threadTitle,
  };
}

function mergeStructuredFinalOutput(current, next) {
  if (!next) return current;
  return {
    finalResponse: next.finalResponse ?? current?.finalResponse ?? null,
    commitSubject: next.commitSubject ?? current?.commitSubject ?? null,
    aiLabel: next.aiLabel ?? current?.aiLabel ?? null,
    threadTitle: next.threadTitle ?? current?.threadTitle ?? null,
  };
}

function summarizeToolInput(input, maxLength = 400) {
  try {
    const command = typeof input?.command === 'string' ? input.command : null;
    const rendered = command ?? JSON.stringify(input ?? {});
    return rendered.length > maxLength ? `${rendered.slice(0, maxLength - 3)}...` : rendered;
  } catch {
    return '';
  }
}

function emitToolStarted(block, seenToolUseIds) {
  if (!block || typeof block !== 'object') return;
  if (!['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(block.type)) return;
  if (isStructuredOutputBlock(block)) return;
  if (block.id && seenToolUseIds?.has(block.id)) return;
  if (block.id) seenToolUseIds?.add(block.id);
  const toolName = block.name ?? 'tool';
  emit({
    type: 'tool_use',
    id: block.id ?? null,
    name: toolName,
    toolName,
    input: block.input ?? {},
    tool_input: block.input ?? {},
    detail: summarizeToolInput(block.input),
    provider_item_id: block.id ?? null,
    timestamp: nowMs(),
  });
}

function sdkUserMessage(content, priority = 'now') {
  return {
    type: 'user',
    parent_tool_use_id: null,
    isSynthetic: false,
    priority,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
    },
  };
}

function createMessageQueue() {
  const messages = [];
  const waiters = [];
  let closed = false;
  return {
    push(message) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: message, done: false });
      } else {
        messages.push(message);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (messages.length > 0) {
            return Promise.resolve({ value: messages.shift(), done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

function createControlReader(onControl) {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const control = JSON.parse(trimmed);
      onControl(control);
    } catch (error) {
      emit({
        type: 'provider_steer_failed',
        error: `Invalid control message: ${error.message}`,
        timestamp: nowMs(),
      });
    }
  });
  return rl;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args.prompt ?? '';
  let cumulativeText = '';
  let activeSessionId = args.providerThreadId ?? args.sessionId ?? null;
  let lastAssistantUuid = null;
  let lastUsage = null;
  let deltaCount = 0;
  let firstDeltaTs = null;
  let structuredFinalOutput = null;
  const seenToolUseIds = new Set();
  const structuredOutputToolUseIds = new Set();
  const rawMessageTypes = new Set();

  emitTrace('adapter_started', { node_id: args.nodeId, cwd: process.cwd() });

  const authError = probeClaudeAuth();
  if (authError) {
    emit({
      type: 'error',
      content: authError.includes('claude auth login')
        ? authError
        : `${authError} Run \`claude auth login\` in a terminal, then retry from Agentree.`,
      timestamp: nowMs(),
    });
    emit({
      type: 'provider_stop',
      provider_stop_reason: 'auth_missing',
      provider_status: 'failed',
      final_content: '',
      provider_thread_id: activeSessionId,
      provider_turn_id: lastAssistantUuid,
      usage: lastUsage,
      timestamp: nowMs(),
    });
    return 1;
  }

  const requestedStrategy = ['resume', 'fork', 'fork_then_rollback', 'fresh_thread'].includes(args.providerThreadStrategy)
    ? args.providerThreadStrategy
    : 'fresh_thread';
  const sourceThreadId = args.sourceProviderThreadId || args.providerThreadId || null;
  if (['resume', 'fork', 'fork_then_rollback'].includes(requestedStrategy) && !sourceThreadId) {
    const message = providerThreadReuseMessage(
      'Claude',
      requestedStrategy === 'resume' ? 'resume' : 'fork',
      'Agentree did not have a source provider thread id for the parent node.'
    );
    emit({
      type: 'provider_meta',
      meta: {
        provider: 'claude',
        transport: 'claude_agent_sdk',
        provider_client: 'agentree',
        provider_thread_strategy: 'failed',
        provider_initial_strategy_selected: requestedStrategy,
        provider_source_thread_id: sourceThreadId,
        provider_source_turn_id: args.providerTurnId || null,
        provider_error_code: 'provider_thread_reuse_failed',
        provider_error_message: message,
        provider_fallback_strategy_selected: null,
        provider_fallback_reason_code: 'provider_source_thread_missing',
      },
      timestamp: nowMs(),
    });
    emit({ type: 'error', content: message, timestamp: nowMs() });
    emit({
      type: 'provider_stop',
      provider_stop_reason: 'provider_source_thread_missing',
      provider_status: 'failed',
      final_content: message,
      provider_thread_id: activeSessionId,
      provider_turn_id: lastAssistantUuid,
      usage: lastUsage,
      timestamp: nowMs(),
    });
    return 1;
  }

  const canResume = requestedStrategy === 'resume' && sourceThreadId;
  const canFork = ['fork', 'fork_then_rollback'].includes(requestedStrategy) && sourceThreadId;
  const shouldResume = canResume || canFork;
  const threadStrategy = canFork ? 'fork' : canResume ? 'resume' : 'fresh_thread';
  const resumeSessionAt = canFork ? (args.targetProviderTurnId || args.providerTurnId || null) : null;

  if (canFork && !resumeSessionAt) {
    const message = providerThreadReuseMessage(
      'Claude',
      'fork',
      'The parent node is missing the provider turn id needed to fork at the branch point.'
    );
    emit({
      type: 'provider_meta',
      meta: {
        provider: 'claude',
        transport: 'claude_agent_sdk',
        provider_client: 'agentree',
        provider_thread_strategy: 'failed',
        provider_initial_strategy_selected: requestedStrategy,
        provider_source_thread_id: sourceThreadId,
        provider_source_turn_id: args.providerTurnId || null,
        provider_error_code: 'provider_thread_reuse_failed',
        provider_error_message: message,
        provider_fallback_strategy_selected: null,
        provider_fallback_reason_code: 'provider_target_turn_missing',
      },
      timestamp: nowMs(),
    });
    emit({ type: 'error', content: message, timestamp: nowMs() });
    emit({
      type: 'provider_stop',
      provider_stop_reason: 'provider_target_turn_missing',
      provider_status: 'failed',
      final_content: message,
      provider_thread_id: activeSessionId,
      provider_turn_id: lastAssistantUuid,
      usage: lastUsage,
      timestamp: nowMs(),
    });
    return 1;
  }

  activeSessionId = canFork ? null : (sourceThreadId || activeSessionId);
  const providerLineageId = args.sourceProviderLineageId || sourceThreadId || activeSessionId;

  emit({
    type: 'provider_meta',
    meta: {
      provider: 'claude',
      transport: 'claude_agent_sdk',
      provider_client: 'agentree',
      provider_thread_strategy: threadStrategy,
      provider_source_thread_id: sourceThreadId,
      provider_source_turn_id: args.providerTurnId || null,
      provider_lineage_id: providerLineageId,
      provider_thread_resume_enabled: threadStrategy === 'resume',
      provider_thread_fork_enabled: Boolean(canFork),
      provider_initial_strategy_selected: requestedStrategy,
      provider_target_turn_id: resumeSessionAt,
      provider_model: args.model,
      provider_reasoning_effort: args.effort,
      provider_run_mode: args.permissionMode,
      provider_branch_target_node_id: args.targetNodeId || args.nodeId,
    },
  });

  const permissionMode = args.permissionMode || undefined;
  const options = {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'agentree/0.1.0',
    },
    includePartialMessages: true,
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort, thinking: { type: 'adaptive' } } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    ...(args.mcpServers ? { mcpServers: args.mcpServers } : {}),
    ...(process.cwd() ? { additionalDirectories: [process.cwd()] } : {}),
    ...(shouldResume ? {
      resume: sourceThreadId,
      ...(canFork ? { forkSession: true } : {}),
      ...(resumeSessionAt ? { resumeSessionAt } : {}),
    } : args.sessionId ? { sessionId: args.sessionId } : {}),
    outputFormat: {
      type: 'json_schema',
      schema: FINAL_RESULT_SCHEMA,
    },
    canUseTool: async (toolName, input) => {
      if (toolName === 'ExitPlanMode') {
        const plan = typeof input?.plan === 'string' ? input.plan.trim() : '';
        if (plan) {
          emit({ type: 'message_completed', content: plan, timestamp: nowMs() });
        }
        return {
          behavior: 'deny',
          message: 'The client captured your proposed plan. Stop here and wait for the user.',
        };
      }
      if (args.denyTools) {
        return {
          behavior: 'deny',
          message: 'Tool use is disabled for this internal completion. Respond directly in the requested output format.',
        };
      }
      return { behavior: 'allow', updatedInput: input };
    },
  };

  const inputQueue = createMessageQueue();
  inputQueue.push(sdkUserMessage(prompt));
  const controlReader = createControlReader((control) => {
    if (control.type !== 'steer' && control.control_type !== 'steer') return;
    const content = typeof control.content === 'string' ? control.content.trim() : '';
    if (!content) {
      emit({
        type: 'provider_steer_failed',
        idempotency_key: control.idempotency_key ?? null,
        error: 'Steering message cannot be empty.',
        timestamp: nowMs(),
      });
      return;
    }
    inputQueue.push(sdkUserMessage(content, 'now'));
    emit({
      type: 'provider_steer_ack',
      idempotency_key: control.idempotency_key ?? null,
      provider_thread_id: activeSessionId,
      provider_turn_id: lastAssistantUuid,
      timestamp: nowMs(),
    });
  });

  try {
    const stream = query({ prompt: inputQueue, options });
    for await (const message of stream) {
      rawMessageTypes.add(message.type);
      if (message.session_id && message.session_id !== activeSessionId) {
        activeSessionId = message.session_id;
        emit({ type: 'session', session_id: activeSessionId, provider: 'claude', transport: 'claude_agent_sdk' });
        emit({
          type: 'provider_meta',
          meta: {
            provider_thread_id: activeSessionId,
            provider_lineage_id: providerLineageId || activeSessionId,
          },
        });
      }

      if (message.type === 'system' && message.subtype === 'init') {
        emit({
          type: 'provider_meta',
          meta: {
            provider_thread_id: message.session_id ?? activeSessionId,
            provider_model: message.model ?? args.model,
            provider_reasoning_effort: args.effort,
            provider_permission_mode: message.permissionMode ?? permissionMode,
            provider_claude_code_version: message.claude_code_version,
            provider_mcp_servers: message.mcp_servers,
          },
        });
        continue;
      }

      if (message.type === 'stream_event') {
        const event = message.event;
        if (event?.type === 'content_block_start') {
          if (isStructuredOutputBlock(event.content_block)) {
            if (event.content_block?.id) structuredOutputToolUseIds.add(event.content_block.id);
            continue;
          }
          emitToolStarted(event.content_block, seenToolUseIds);
          continue;
        }
        if (event?.type === 'content_block_delta') {
          const delta = event.delta;
          const textDelta =
            delta?.type === 'text_delta'
              ? delta.text
              : delta?.type === 'thinking_delta'
                ? delta.thinking
                : '';
          if (typeof textDelta === 'string' && textDelta.length > 0) {
            if (delta.type === 'thinking_delta') {
              emit({ type: 'thinking', content: textDelta, timestamp: nowMs() });
            } else {
              // Structured-output turns may stream wrapper text; only expose the parsed final_response.
              deltaCount += 1;
              firstDeltaTs ??= nowMs();
            }
          }
          continue;
        }
        continue;
      }

      if (message.type === 'assistant') {
        lastAssistantUuid = message.uuid ?? lastAssistantUuid;
        const content = message?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && isStructuredOutputBlock(block)) {
              if (block.id) structuredOutputToolUseIds.add(block.id);
              structuredFinalOutput = mergeStructuredFinalOutput(
                structuredFinalOutput,
                structuredFinalOutputFromInput(block.input)
              );
            }
          }
        }
        const text = extractAssistantText(message);
        if (text && !structuredFinalOutput) {
          cumulativeText = text.length >= cumulativeText.length ? text : cumulativeText;
          emit({
            type: 'message_completed',
            content: text,
            provider_thread_id: message.session_id ?? activeSessionId,
            provider_item_id: message.uuid ?? null,
            timestamp: nowMs(),
          });
        }
        if (Array.isArray(content)) {
          for (const block of content) emitToolStarted(block, seenToolUseIds);
        }
        continue;
      }

      if (message.type === 'user') {
        for (const result of extractToolResults(message, structuredOutputToolUseIds)) emit(result);
        continue;
      }

      if (message.type === 'tool_progress') {
        emit({
          type: 'thinking',
          content: `${message.tool_name} running (${message.elapsed_time_seconds}s)`,
          timestamp: nowMs(),
        });
        continue;
      }

      if (message.type === 'tool_use_summary') {
        emit({ type: 'thinking', content: message.summary, timestamp: nowMs() });
        continue;
      }

      if (message.type === 'rate_limit_event') {
        const providerLimits = mapRateLimitInfo(message.rate_limit_info);
        if (providerLimits) {
          emit({
            type: 'provider_meta',
            meta: {
              provider: 'claude',
              provider_limits: providerLimits,
            },
            timestamp: nowMs(),
          });
        }
        continue;
      }

      if (message.type === 'result') {
        lastUsage = mapUsage(message.usage) ?? lastUsage;
        if (lastUsage) {
          emit({ type: 'usage', usage: lastUsage, timestamp: nowMs() });
        }
        const finalContent = typeof message.result === 'string' && message.result.length > 0
          ? message.result
          : cumulativeText;
        const visibleFinalContent = structuredFinalOutput?.finalResponse || finalContent;
        const structuredMeta = {};
        if (structuredFinalOutput?.commitSubject) {
          structuredMeta.commit_subject = structuredFinalOutput.commitSubject;
        }
        if (structuredFinalOutput?.aiLabel) {
          structuredMeta.ai_label = structuredFinalOutput.aiLabel;
        }
        if (structuredFinalOutput?.threadTitle) {
          structuredMeta.thread_title = structuredFinalOutput.threadTitle;
        }
        if (Object.keys(structuredMeta).length > 0) {
          emit({
            type: 'provider_meta',
            meta: structuredMeta,
            timestamp: nowMs(),
          });
        }
        emit({
          type: 'provider_meta',
          meta: {
            provider_notification_methods: Array.from(rawMessageTypes).sort(),
            provider_thread_id: message.session_id ?? activeSessionId,
            provider_turn_id: message.uuid ?? lastAssistantUuid,
            provider_last_assistant_uuid: lastAssistantUuid,
            provider_stream: {
              first_delta_ts: firstDeltaTs,
              delta_count: deltaCount,
            },
          },
        });
        emit({
          type: 'provider_stop',
          provider_stop_reason: message.stop_reason ?? message.subtype ?? 'end_turn',
          provider_status: message.is_error ? 'failed' : 'completed',
          final_content: visibleFinalContent,
          provider_thread_id: message.session_id ?? activeSessionId,
          provider_turn_id: message.uuid ?? lastAssistantUuid,
          usage: lastUsage,
          timestamp: nowMs(),
        });
        return message.is_error ? 1 : 0;
      }

      if (message.type === 'auth_status') {
        emit({
          type: message.error ? 'error' : 'thinking',
          content: message.error || message.output?.join('\n') || 'Claude authentication status changed.',
          timestamp: nowMs(),
        });
      }
    }

    emit({
      type: 'provider_stop',
      provider_stop_reason: 'stream_ended',
      provider_status: 'completed',
      final_content: cumulativeText,
      provider_thread_id: activeSessionId,
      provider_turn_id: lastAssistantUuid,
      usage: lastUsage,
      timestamp: nowMs(),
    });
    return 0;
  } catch (error) {
    const action = threadStrategy === 'resume'
      ? 'resume'
      : threadStrategy === 'fork'
        ? 'fork'
        : null;
    const content = action
      ? providerThreadReuseMessage('Claude', action, error?.message ?? String(error))
      : `Claude Agent SDK adapter failed: ${error?.message ?? String(error)}`;
    const stopReason = action
      ? `${action}_failed:${error?.name ?? 'Error'}`
      : 'error';
    if (action) {
      emit({
        type: 'provider_meta',
        meta: {
          provider_error_code: 'provider_thread_reuse_failed',
          provider_error_message: content,
          provider_fallback_strategy_selected: null,
          provider_fallback_reason_code: stopReason,
          provider_thread_strategy: 'failed',
          provider_initial_strategy_selected: requestedStrategy,
          provider_source_thread_id: sourceThreadId,
          provider_source_turn_id: args.providerTurnId || null,
        },
        timestamp: nowMs(),
      });
    }
    emit({
      type: 'error',
      content,
      timestamp: nowMs(),
    });
    emit({
      type: 'provider_stop',
      provider_stop_reason: stopReason,
      provider_status: 'failed',
      final_content: action ? content : cumulativeText,
      provider_thread_id: activeSessionId,
      provider_turn_id: lastAssistantUuid,
      usage: lastUsage,
      timestamp: nowMs(),
    });
    return 1;
  } finally {
    inputQueue.close();
    controlReader.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const exitCode = await main();
  process.exit(exitCode);
}
