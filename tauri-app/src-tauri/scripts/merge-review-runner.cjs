#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const DEPENDENCY_GUARD_INSTRUCTION = 'Dependency rule: some dependency and build directories in this worktree are symlinked and must be treated as read-only. Do not install, remove, upgrade, rebuild, or delete project dependencies or write build output into those symlinked directories. It is okay to run read-only checks, tests, and builds when their caches and build output are redirected outside those symlinked directories. If you need to build, test, or install dependencies in a way that would write there, avoid doing it yourself and explicitly tell the user what needs to be run so they can do it outside the agent worktree.';

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function normalizeReviewPayload(raw) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  return {
    targetCommit: payload.targetCommit || payload.target_commit || '',
    sourceCommits: Array.isArray(payload.sourceCommits)
      ? payload.sourceCommits
      : (Array.isArray(payload.source_commits) ? payload.source_commits : []),
    files: Array.isArray(payload.files) ? payload.files : [],
  };
}

function normalizeSynthesisPayload(raw) {
  const payload = normalizeReviewPayload(raw);
  return {
    ...payload,
    issues: Array.isArray(raw?.issues) ? raw.issues : [],
    selections: Array.isArray(raw?.selections) ? raw.selections : [],
  };
}

function tokenizeArgs(value) {
  const input = String(value || '').trim();
  if (!input) return [];
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function parseCliArgs(value) {
  const tokens = tokenizeArgs(value);
  let model = null;
  let permissionMode = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token === '--model' && next) {
      model = next;
      index += 1;
      continue;
    }
    if (token === '--permission-mode' && next) {
      permissionMode = next;
      index += 1;
    }
  }
  return { model, permissionMode };
}

function normalizeCodexModel(model) {
  const raw = String(model || '').trim();
  if (!raw) return null;
  const normalized = raw.includes('/') ? raw.split('/').pop() : raw;
  if (!normalized) return null;

  // ChatGPT-authenticated Codex commonly rejects legacy/non-Codex models
  // such as gpt-4o-mini. Let Codex pick its default model in those cases.
  if (normalized.startsWith('gpt-4o')) return null;
  return normalized;
}

function buildReviewPrompt(payloadPath, payload) {
  return [
    'You are performing an AI merge review for Agentree.',
    `Read the structured review input from ${payloadPath}.`,
    `The target commit is ${payload.targetCommit} and the merge includes ${payload.sourceCommits.length} source commit(s).`,
    'Review every changed file and determine whether there are semantic conflicts or hidden risks even if Git can merge cleanly.',
    'Only raise issues that require explicit product or behavioral user choice.',
    'If a file or conflict can be safely resolved automatically, do not surface it as an issue.',
    'Group related files into one semantic issue whenever they represent the same decision.',
    'You may inspect the repository with git commands if the payload is not enough.',
    'Return ONLY JSON, with no markdown fences and no explanation outside JSON.',
    'JSON schema:',
    '{"summary":{"overallVerdict":"safe|needs-attention|blocked","summaryText":"string","riskLevel":"low|medium|high","changedFilesCount":number,"riskyFilesCount":number},"issues":[{"id":"string","title":"string","summary":"string","riskLevel":"low|medium|high","rationale":"string","affectedFiles":["string"],"options":[{"id":"string","label":"string","kind":"target|source","sourceCommit":"string|null","sourceLabel":"string|null","description":"string|null"}]}]}',
    'Return zero issues when no user decision is required.',
    'Every affectedFiles entry must be a changed file from the payload.',
    'Use semantic option labels such as preserving target behavior or taking a specific source branch approach.',
  ].join('\n');
}

function buildSynthesisPrompt(payloadPath, payload) {
  return [
    'You are synthesizing a machine-applicable merge resolution plan for Agentree.',
    `Read the structured synthesis input from ${payloadPath}.`,
    'The payload includes changed files, semantic issues returned by review, and the user selections for those issues.',
    'Produce one concrete resolution for every changed file.',
    'Respect the selected option for each issue and infer safe automatic resolutions for files not covered by any issue.',
    'Use action=source with sourceCommit when a specific source branch should win.',
    'Use action=target when target behavior should be preserved.',
    'Use action=base only when reverting to the merge base is correct.',
    'Use action=manual only when you must synthesize content; include full content in that case.',
    'You may inspect the repository with git commands if the payload is not enough.',
    'Return ONLY JSON, with no markdown fences and no explanation outside JSON.',
    'JSON schema:',
    '{"summaryText":"string","resolutions":[{"path":"string","action":"source|target|base|manual","sourceCommit":"string|null","content":"string|null","rationale":"string"}]}',
    'summaryText should clearly explain what target behavior was preserved, which source behaviors were taken, and what was auto-resolved safely.',
    `Include exactly ${payload.files.length} resolutions, one for each changed file in the payload.`,
  ].join('\n');
}

function extractText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return value.content.map(extractText).filter(Boolean).join('');
    if (Array.isArray(value.output)) return value.output.map(extractText).filter(Boolean).join('');
    if (typeof value.message === 'string') return value.message;
    if (value.message) return extractText(value.message);
  }
  return '';
}

function summarizeToolPayload(value, maxLength = 120) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const singleLine = value.replace(/\s+/g, ' ').trim();
    return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}...` : singleLine;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const rendered = value.slice(0, 4).map((entry) => summarizeToolPayload(entry, 24)).filter(Boolean).join(', ');
    return value.length > 4 ? `${rendered}, ...` : rendered;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .slice(0, 4)
      .map(([key, entry]) => `${key}=${summarizeToolPayload(entry, 24)}`);
    const rendered = entries.join(', ');
    return Object.keys(value).length > 4 ? `${rendered}, ...` : rendered;
  }
  return '';
}

function normalizeCodexEvent(event, activeTools) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'thinking') {
    return { level: 'info', message: event.thinking || event.content || 'Agent is thinking...' };
  }
  if (event.type === 'tool_use') {
    const toolName = event.name || event.toolName || 'tool';
    if (event.id) {
      activeTools.set(event.id, toolName);
    }
    const payloadSummary = summarizeToolPayload(event.input);
    return {
      level: 'info',
      message: payloadSummary
        ? `Tool call: ${toolName} (${payloadSummary})`
        : `Tool call: ${toolName}`,
    };
  }
  if (event.type === 'tool_result') {
    const toolName = (event.id && activeTools.get(event.id)) || event.name || event.toolName || 'tool';
    if (event.id) {
      activeTools.delete(event.id);
    }
    const payloadSummary = summarizeToolPayload(event.content, 80);
    return {
      level: event.isError ? 'warning' : 'info',
      message: payloadSummary
        ? `Tool result: ${toolName} -> ${payloadSummary}`
        : `Tool result: ${toolName} finished`,
    };
  }
  if (event.type === 'error') {
    return { level: 'error', message: event.content || event.data || 'Agent error' };
  }
  return null;
}

function extractJsonBlock(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Agent returned empty output');
  }

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error('Agent did not return valid JSON');
    }
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  }
}

function validateReviewResult(result, payload) {
  const issues = Array.isArray(result?.issues) ? result.issues : null;
  const summary = result?.summary;
  if (!summary || typeof summary !== 'object') {
    throw new Error('Merge review result is missing summary');
  }
  if (!Array.isArray(issues)) {
    throw new Error('Merge review result is missing issues array');
  }

  const expectedPaths = new Set(payload.files.map((file) => file.path));
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object' || typeof issue.id !== 'string') {
      throw new Error('Merge review issue is missing id');
    }
    if (typeof issue.title !== 'string' || typeof issue.summary !== 'string' || typeof issue.rationale !== 'string') {
      throw new Error(`Incomplete merge review issue ${issue.id}`);
    }
    if (!Array.isArray(issue.affectedFiles) || issue.affectedFiles.length === 0) {
      throw new Error(`Issue ${issue.id} must include affectedFiles`);
    }
    for (const filePath of issue.affectedFiles) {
      if (!expectedPaths.has(filePath)) {
        throw new Error(`Issue ${issue.id} references unknown file ${filePath}`);
      }
    }
    if (!Array.isArray(issue.options) || issue.options.length === 0) {
      throw new Error(`Issue ${issue.id} must include options`);
    }
    for (const option of issue.options) {
      if (!option || typeof option !== 'object' || typeof option.id !== 'string' || typeof option.label !== 'string') {
        throw new Error(`Issue ${issue.id} contains an invalid option`);
      }
      if (option.kind !== 'target' && option.kind !== 'source') {
        throw new Error(`Issue ${issue.id} contains an invalid option kind`);
      }
      if (option.kind === 'source' && option.sourceCommit && !payload.sourceCommits.includes(option.sourceCommit)) {
        throw new Error(`Issue ${issue.id} references unknown source commit ${option.sourceCommit}`);
      }
    }
  }

  return {
    summary: {
      overallVerdict: summary.overallVerdict || 'needs-attention',
      summaryText: typeof summary.summaryText === 'string' ? summary.summaryText : 'Merge review completed.',
      riskLevel: summary.riskLevel || 'medium',
      changedFilesCount: Number(summary.changedFilesCount || payload.files.length),
      riskyFilesCount: Number(summary.riskyFilesCount ?? issues.length),
    },
    issues: issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      summary: issue.summary,
      riskLevel: issue.riskLevel || 'medium',
      rationale: issue.rationale,
      affectedFiles: issue.affectedFiles,
      options: issue.options.map((option) => ({
        id: option.id,
        label: option.label,
        kind: option.kind,
        sourceCommit: option.sourceCommit ?? null,
        sourceLabel: option.sourceLabel ?? null,
        description: option.description ?? null,
      })),
    })),
  };
}

function validateSynthesisResult(result, payload) {
  const resolutions = Array.isArray(result?.resolutions) ? result.resolutions : null;
  if (!Array.isArray(resolutions)) {
    throw new Error('Merge synthesis result is missing resolutions');
  }

  const expectedPaths = new Set(payload.files.map((file) => file.path));
  const seenPaths = new Set();
  for (const resolution of resolutions) {
    if (!resolution || typeof resolution !== 'object' || typeof resolution.path !== 'string') {
      throw new Error('Merge synthesis resolution is missing path');
    }
    if (!expectedPaths.has(resolution.path)) {
      throw new Error(`Unexpected synthesis resolution for ${resolution.path}`);
    }
    if (!['source', 'target', 'base', 'manual'].includes(resolution.action)) {
      throw new Error(`Invalid synthesis action for ${resolution.path}`);
    }
    if (resolution.action === 'source' && resolution.sourceCommit && !payload.sourceCommits.includes(resolution.sourceCommit)) {
      throw new Error(`Unknown source commit ${resolution.sourceCommit} for ${resolution.path}`);
    }
    if (resolution.action === 'manual' && typeof resolution.content !== 'string') {
      throw new Error(`Manual synthesis resolution for ${resolution.path} must include content`);
    }
    seenPaths.add(resolution.path);
  }

  if (seenPaths.size !== expectedPaths.size) {
    const missing = [...expectedPaths].filter((entry) => !seenPaths.has(entry));
    throw new Error(`Missing synthesis resolutions for: ${missing.join(', ')}`);
  }

  return {
    summaryText: typeof result?.summaryText === 'string' ? result.summaryText : 'Merge resolutions synthesized.',
    resolutions: resolutions.map((resolution) => ({
      path: resolution.path,
      action: resolution.action,
      sourceCommit: resolution.sourceCommit ?? null,
      content: resolution.content ?? null,
    })),
  };
}

function buildCodexCommand(config, prompt) {
  const program = String(config.codexAdapterProgram || '').trim();
  if (!program) {
    throw new Error('Missing Codex adapter program. Agentree should provide its Rust adapter command.');
  }
  const prefix = Array.isArray(config.codexAdapterArgsPrefix)
    ? config.codexAdapterArgsPrefix.map((arg) => String(arg))
    : [];
  const rawArgs = tokenizeArgs(config.cliArgs);
  let model = null;
  let reasoningEffort = null;
  let permissionMode = null;
  for (let index = 0; index < rawArgs.length; index += 1) {
    if (rawArgs[index] === '--model' && rawArgs[index + 1]) {
      model = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (rawArgs[index] === '--reasoning-effort' && rawArgs[index + 1]) {
      reasoningEffort = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (rawArgs[index] === '--permission-mode' && rawArgs[index + 1]) {
      permissionMode = rawArgs[index + 1];
      index += 1;
    }
  }

  const cliArgs = [];
  const effectiveModel = normalizeCodexModel(model);
  if (effectiveModel) {
    cliArgs.push('--model', effectiveModel);
  }
  if (reasoningEffort) {
    cliArgs.push('--reasoning-effort', reasoningEffort);
  }
  if (permissionMode) {
    cliArgs.push('--permission-mode', permissionMode);
  }
  return {
    program,
    args: [...prefix, ...cliArgs, prompt],
  };
}

function buildClaudeArgs(config, prompt) {
  const cliArgs = tokenizeArgs(config.cliArgs);
  const cleaned = [];
  for (let index = 0; index < cliArgs.length; index += 1) {
    const arg = cliArgs[index];
    const next = cliArgs[index + 1];
    if (arg === '--output-format' || arg === '--session-id') {
      index += 1;
      continue;
    }
    if (arg === '-p' || arg === '--print' || arg === '--verbose' || arg === '--no-session-persistence') {
      continue;
    }
    if (arg === '--permission-mode') {
      cleaned.push(arg, next === 'plan' ? 'auto' : (next || 'auto'));
      index += 1;
      continue;
    }
    cleaned.push(arg);
  }
  if (!cleaned.includes('--permission-mode')) {
    cleaned.push('--permission-mode', 'auto');
  }
  cleaned.push('--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence');

  const promptFlag = config.promptFlag || '-p';
  cleaned.push(promptFlag, prompt);
  return cleaned;
}

async function runCodex(config, prompt, payload) {
  return new Promise((resolve, reject) => {
    const command = buildCodexCommand(config, prompt);
    const child = spawn(command.program, command.args, {
      cwd: config.worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let assistantText = '';
    let errorText = '';
    let sawDelta = false;
    const activeTools = new Map();

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        const timeline = normalizeCodexEvent(event, activeTools);
        if (timeline) {
          emit({ type: 'timeline', event: { timestamp: Date.now(), ...timeline } });
        }
        if (event.type === 'message_delta' && typeof event.delta === 'string') {
          sawDelta = true;
          assistantText += event.delta;
        }
        if (event.type === 'message_completed' && typeof event.content === 'string') {
          // App-server emits both deltas and final snapshot; avoid double appending.
          if (!sawDelta || event.content.length > assistantText.length) {
            assistantText = event.content;
          }
        }
        if (event.type === 'stderr' && typeof event.data === 'string') {
          errorText = event.data;
          emit({
            type: 'timeline',
            event: { timestamp: Date.now(), level: 'warning', message: event.data },
          });
        }
        if (event.type === 'error' && typeof event.content === 'string') {
          errorText = event.content;
        }
        if (
          (event.type === 'stop' && event.status === 'failed') ||
          (event.type === 'provider_stop' && event.provider_status === 'failed')
        ) {
          if (!errorText) {
            errorText = 'Codex exited with a failure status.';
          }
        }
      } catch {
        emit({
          type: 'timeline',
          event: { timestamp: Date.now(), level: 'warning', message: line },
        });
      }
    });

    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on('line', (line) => {
      errorText = line;
      emit({
        type: 'timeline',
        event: { timestamp: Date.now(), level: 'warning', message: line },
      });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errorText || `Codex review failed with code ${code}`));
        return;
      }
      try {
        resolve(extractJsonBlock(assistantText));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function appendClaudeAssistant(innerData, parts) {
  if (innerData.type === 'assistant' && innerData.message?.content) {
    const blocks = Array.isArray(innerData.message.content) ? innerData.message.content : [];
    for (const block of blocks) {
      if (block?.type === 'text' && block.text) {
        parts.push(block.text);
      }
      if (block?.type === 'thinking') {
        emit({
          type: 'timeline',
          event: { timestamp: Date.now(), level: 'info', message: block.thinking || block.text || 'Agent is thinking...' },
        });
      }
      if (block?.type === 'tool_use') {
        emit({
          type: 'timeline',
          event: { timestamp: Date.now(), level: 'info', message: `Using ${block.name || 'tool'}...` },
        });
      }
      if (block?.type === 'tool_result') {
        emit({
          type: 'timeline',
          event: { timestamp: Date.now(), level: block.is_error ? 'warning' : 'info', message: `${block.name || 'tool'} finished` },
        });
      }
    }
    return true;
  }

  if (innerData.type === 'message') {
    const inferredRole =
      innerData.role ||
      innerData.message?.role ||
      (innerData.payload?.item?.type === 'agent_message' ? 'assistant' : null);
    if (inferredRole === 'assistant' || inferredRole == null) {
      parts.push(extractText(innerData));
      return true;
    }
  }

  return false;
}

async function runClaude(config, prompt, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', buildClaudeArgs(config, prompt), {
      cwd: config.worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const assistantParts = [];
    let errorText = '';

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      try {
        const innerData = JSON.parse(line);
        if (appendClaudeAssistant(innerData, assistantParts)) return;
        if (innerData.type === 'error') {
          const message = extractText(innerData) || 'Claude reported an error';
          errorText = message;
          emit({
            type: 'timeline',
            event: { timestamp: Date.now(), level: 'error', message },
          });
        }
      } catch {
        emit({
          type: 'timeline',
          event: { timestamp: Date.now(), level: 'warning', message: line },
        });
      }
    });

    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on('line', (line) => {
      errorText = line;
      emit({
        type: 'timeline',
        event: { timestamp: Date.now(), level: 'warning', message: line },
      });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errorText || `Claude review failed with code ${code}`));
        return;
      }
      try {
        resolve(extractJsonBlock(assistantParts.join('')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const config = JSON.parse(process.argv[2] || '{}');
  const payloadFile = config.payloadFile;
  const mode = config.mode === 'synthesize' ? 'synthesize' : 'review';
  if (!payloadFile) {
    throw new Error('Missing payloadFile');
  }

  const rawPayload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
  const payload = mode === 'synthesize'
    ? normalizeSynthesisPayload(rawPayload)
    : normalizeReviewPayload(rawPayload);
  const prompt = mode === 'synthesize'
    ? buildSynthesisPrompt(path.relative(config.worktreePath || process.cwd(), payloadFile), payload)
    : buildReviewPrompt(path.relative(config.worktreePath || process.cwd(), payloadFile), payload);
  const guardedPrompt = `${DEPENDENCY_GUARD_INSTRUCTION}\n\n${prompt}`;

  emit({
    type: 'status',
    status: 'running',
    phase: 'starting',
    message: mode === 'synthesize'
      ? `Starting ${config.agentName || config.agentType || 'agent'} merge synthesis...`
      : `Starting ${config.agentName || config.agentType || 'agent'} merge review...`,
  });

  let result;
  if (config.agentType === 'claude') {
    result = await runClaude(config, guardedPrompt, payload);
  } else if (!config.agentType || config.agentType === 'codex') {
    result = await runCodex(config, guardedPrompt, payload);
  } else {
    throw new Error(`Unsupported merge review agent type: ${config.agentType}`);
  }

  emit({
    type: 'result',
    result: mode === 'synthesize'
      ? validateSynthesisResult(result, payload)
      : validateReviewResult(result, payload),
  });
  emit({
    type: 'status',
    status: 'completed',
    phase: 'completed',
    message: mode === 'synthesize' ? 'Merge synthesis completed.' : 'Merge review completed.',
  });
}

if (require.main === module) {
  main().catch((error) => {
    emit({
      type: 'error',
      error: error?.message || 'Merge review failed',
    });
    emit({
      type: 'status',
      status: 'failed',
      phase: 'failed',
      message: error?.message || 'Merge review failed',
    });
    process.exit(1);
  });
}

module.exports = {
  buildCodexCommand,
};
