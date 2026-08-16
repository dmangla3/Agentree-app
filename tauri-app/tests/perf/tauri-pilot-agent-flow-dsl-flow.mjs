import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = process.env.AGENTREE_TAURI_PILOT_OUT_DIR ?? 'runtime-logs/tauri-pilot-diagnostics';
const LABEL = process.env.AGENTREE_TAURI_PILOT_LABEL ?? `tauri-pilot-agent-flow-dsl-${Date.now()}`;
const PROMPT = process.env.AGENTREE_TAURI_PILOT_FLOW_PROMPT ?? 'improve UI of workspace tracking dashboard';
const PARALLEL_COUNT = Number(process.env.AGENTREE_TAURI_PILOT_FLOW_COUNT ?? 2);
const MODEL_KEY = process.env.AGENTREE_TAURI_PILOT_AGENT_KEY ?? 'codex:gpt-5.4-mini:low';
const RUN_WAIT_MS = Number(process.env.AGENTREE_TAURI_PILOT_FLOW_WAIT_MS ?? 45 * 60 * 1000);
const REQUIRE_FIXER = process.env.AGENTREE_TAURI_PILOT_REQUIRE_FIXER === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execText = (cmd, args, options = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve(stdout);
  });
});

const pilotEval = async (script, timeoutMs = 120000) => {
  const startedAt = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn('tauri-pilot', ['eval', '--json', '-'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`tauri-pilot eval timed out after ${timeoutMs}ms: ${stderr || stdout}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`tauri-pilot eval exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve({ value: stdout.trim() ? JSON.parse(stdout) : null, roundTripMs: Date.now() - startedAt });
      } catch (error) {
        reject(new Error(`failed to parse tauri-pilot JSON: ${error.message}\n${stdout}`));
      }
    });
    child.stdin.end(script);
  });
};

const waitForPilot = async () => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 120000) {
    try {
      await execText('tauri-pilot', ['ping']);
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for Tauri Pilot: ${lastError?.stderr || lastError?.stdout || lastError?.message || 'no response'}`);
};

const preflight = async () => {
  const stateText = await execText('tauri-pilot', ['--json', 'state']);
  const state = stateText.trim() ? JSON.parse(stateText) : null;
  const appProbe = (await pilotEval(`
(() => ({
  url: location.href,
  readyState: document.readyState,
  visibility: document.visibilityState,
  hasFocus: document.hasFocus(),
  bodyTextSample: document.body?.innerText?.slice(0, 800) ?? '',
  graphNodeCount: document.querySelectorAll('.react-flow__node,[data-agentree-graph-node-id]').length,
  textareaCount: document.querySelectorAll('textarea').length,
  buttonCount: document.querySelectorAll('button').length,
}))()
`)).value;
  const readiness = (await pilotEval(`
(async () => {
  const { agentClient } = await import('http://localhost:1420/src/lib/agentClient.ts');
  return await agentClient.checkRuntimeReadiness('codex');
})()
`, 120000)).value;

  return { state, appProbe, readiness };
};

const installAndStartFlow = async ({ mainSha, startedAtIso }) => {
  return (await pilotEval(`
(async () => {
  const label = ${JSON.stringify(LABEL)};
  const prompt = ${JSON.stringify(PROMPT)};
  const count = ${JSON.stringify(PARALLEL_COUNT)};
  const modelKey = ${JSON.stringify(MODEL_KEY)};
  const mainSha = ${JSON.stringify(mainSha)};
  const startedAtIso = ${JSON.stringify(startedAtIso)};
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const visible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return !element.hidden && element.getAttribute('aria-hidden') !== 'true' && style.display !== 'none' && style.visibility !== 'hidden' && (element.offsetParent || element.getClientRects().length);
  };
  const buttonText = (button) => (button.getAttribute('aria-label') || button.textContent || '').trim();
  const activateElement = (element) => {
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      element.dispatchEvent(new MouseEvent(type, init));
    }
  };
  const findButton = (predicate) => [...document.querySelectorAll('button')].find((button) => visible(button) && predicate(button, buttonText(button))) || null;
  const clickButton = async (name, predicate) => {
    const button = findButton(predicate);
    if (!button) {
      throw new Error('Button not found: ' + name + '; visible=' + JSON.stringify([...document.querySelectorAll('button')].filter(visible).slice(-30).map((item) => buttonText(item))));
    }
    activateElement(button);
    await sleep(350);
    return buttonText(button);
  };
  const clickMenuItem = async (name, predicate) => {
    const item = [...document.querySelectorAll('[role="menuitem"],[cmdk-item],button')]
      .find((element) => visible(element) && predicate(element, (element.getAttribute('aria-label') || element.textContent || '').trim())) || null;
    if (!item) {
      throw new Error('Menu item not found: ' + name + '; visible=' + JSON.stringify([...document.querySelectorAll('[role="menuitem"],button')].filter(visible).slice(-40).map((item) => (item.getAttribute('aria-label') || item.textContent || '').trim())));
    }
    activateElement(item);
    await sleep(350);
    return (item.getAttribute('aria-label') || item.textContent || '').trim();
  };
  const setTextArea = async (value) => {
    const textarea = document.querySelector('[data-testid="chat-composer-textarea"]') || document.querySelector('textarea[placeholder^="Ask anything"]') || [...document.querySelectorAll('textarea')].find(visible);
    if (!textarea) throw new Error('Composer textarea not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.focus();
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(100);
    return textarea.value;
  };
  const setNumberInput = async (selector, value) => {
    const input = document.querySelector(selector);
    if (!input) throw new Error('Number input not found: ' + selector);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(value));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(100);
    return input.value;
  };

  const { useWorkspaceStore } = await import('http://localhost:1420/src/stores/workspaceStore.ts');
  const { runtimeModels } = await import('http://localhost:1420/src/lib/runtimeModels.ts');
  const store = useWorkspaceStore.getState();
  const workspaceId = store.selectedWorkspaceId;
  if (!workspaceId) throw new Error('No selected workspace');
  if (!runtimeModels.some((model) => model.key === modelKey)) throw new Error('Runtime model key not found: ' + modelKey);

  store.setSelectedAgentId(modelKey);
  store.setComposerBaseCommitOverride({ workspaceId, commitSha: mainSha, label: 'main', source: 'graph-header' });
  await sleep(250);

  await clickButton('Workspace', (_button, text) => text === 'Workspace');
  await sleep(250);
  await clickButton('Select reply target', (_button, text) => text === 'Select reply target');
  await clickMenuItem('Start new thread', (_item, text) => text.includes('Start new thread'));
  await clickButton('Flow tab', (_button, text) => text === 'Flow');
  await setTextArea(prompt);
  const countValue = await setNumberInput('#flow-parallel-count', count);
  const runButton = findButton((_button, text) => text === 'Run Flow');
  if (!runButton) throw new Error('Run Flow button not found');
  if (runButton.disabled) throw new Error('Run Flow button is disabled');
  window.__AGENTREE_FLOW_DSL_PILOT__ = {
    label,
    startedAtIso,
    prompt,
    count,
    modelKey,
    mainSha,
    workspaceId,
    flowRunId: null,
    startClickedAtIso: null,
  };
  window.__AGENTREE_PERF__?.clear?.();
  window.__AGENTREE_PERF__?.startCapture?.(label);
  activateElement(runButton);
  window.__AGENTREE_FLOW_DSL_PILOT__.startClickedAtIso = new Date().toISOString();
  await sleep(250);
  return {
    workspaceId,
    modelKey,
    mainSha,
    countValue,
    runButtonText: buttonText(runButton),
    url: location.href,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
  };
})()
`, 120000)).value;
};

const collectSummary = async () => {
  return (await pilotEval(`
(async () => {
  const probe = window.__AGENTREE_FLOW_DSL_PILOT__ ?? {};
  const { agentClient } = await import('http://localhost:1420/src/lib/agentClient.ts');
  const workspaceId = probe.workspaceId;
  if (!workspaceId) return { probe, error: 'missing workspace id' };
  const rows = await agentClient.listLocalNodes(workspaceId);
  const startedMs = Date.parse(probe.startedAtIso || '') - 2000;
  const parsed = rows.flatMap((row) => {
    try {
      const message = JSON.parse(row.payload);
      const meta = message?.execution_data?.meta ?? {};
      const createdMs = Date.parse(message.createdAt || '') || (Number(row.finalizedAt) * 1000);
      if (meta.flow_id !== 'parallel_review_until_satisfied') return [];
      if (Number.isFinite(startedMs) && Number.isFinite(createdMs) && createdMs < startedMs) return [];
      return [{
        row,
        message,
        meta,
        createdMs,
      }];
    } catch {
      return [];
    }
  });
  const groups = new Map();
  for (const item of parsed) {
    const flowRunId = item.meta.flow_run_id || 'unknown';
    const group = groups.get(flowRunId) ?? [];
    group.push(item);
    groups.set(flowRunId, group);
  }
  const chosen = probe.flowRunId && groups.has(probe.flowRunId)
    ? probe.flowRunId
    : [...groups.entries()]
      .map(([flowRunId, items]) => ({ flowRunId, latest: Math.max(...items.map((item) => item.createdMs || 0)), count: items.length }))
      .sort((left, right) => right.latest - left.latest)[0]?.flowRunId ?? null;
  if (chosen && !probe.flowRunId) {
    probe.flowRunId = chosen;
  }
  const items = chosen ? (groups.get(chosen) ?? []) : [];
  const messages = items.map(({ message, meta, createdMs }) => ({
    id: message.id,
    role: message.role,
    status: message.status ?? null,
    templateId: meta.flow_node_template_id ?? null,
    flowRunId: meta.flow_run_id ?? null,
    parentId: message.parentId ?? null,
    baseCommitSha: message.base_commit_sha ?? meta.base_commit_sha ?? null,
    outputCommitSha: message.output_commit_sha ?? null,
    llmModel: message.llmModel ?? meta.provider_model ?? null,
    reasoningEffort: meta.provider_reasoning_effort ?? null,
    createdAt: message.createdAt ?? null,
    updatedAt: message.updatedAt ?? null,
    content: String(message.content ?? ''),
  })).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const assistants = messages.filter((message) => message.role === 'assistant');
  const users = messages.filter((message) => message.role === 'user');
  const terminalStatuses = new Set(['completed', 'failed', 'error', 'cancelled']);
  const activeAssistants = assistants.filter((message) => !terminalStatuses.has(message.status));
  const byTemplate = {};
  for (const message of assistants) {
    const key = message.templateId || 'unknown';
    const bucket = byTemplate[key] ?? { total: 0, completed: 0, failed: 0, cancelled: 0, commits: 0 };
    bucket.total += 1;
    if (message.status === 'completed') bucket.completed += 1;
    if (message.status === 'failed' || message.status === 'error') bucket.failed += 1;
    if (message.status === 'cancelled') bucket.cancelled += 1;
    if (message.outputCommitSha) bucket.commits += 1;
    byTemplate[key] = bucket;
  }
  const buttonLabels = [...document.querySelectorAll('button')]
    .filter((button) => button.offsetParent || button.getClientRects().length)
    .map((button) => (button.getAttribute('aria-label') || button.textContent || '').trim())
    .slice(-40);
  const flowPanelText = document.body?.innerText?.split('\\n').filter((line) => /Flow|Started|Completed|Stopped|Ready|Running|failed/i.test(line)).slice(-25) ?? [];
  return {
    probe,
    chosenFlowRunId: chosen,
    messageCount: messages.length,
    userCount: users.length,
    assistantCount: assistants.length,
    activeAssistantCount: activeAssistants.length,
    byTemplate,
    users: users.map((message) => ({ ...message, content: message.content.slice(0, 3000) })),
    assistants: assistants.map((message) => ({ ...message, content: message.content.slice(0, 3000) })),
    buttonLabels,
    flowPanelText,
    runButtonDisabled: [...document.querySelectorAll('button')].find((button) => (button.textContent || '').trim() === 'Run Flow')?.disabled ?? null,
    perfEvents: window.__AGENTREE_PERF__?.readLatestSession?.()?.filter((event) => String(event?.name || '').includes('send-flow') || String(event?.name || '').includes('agent-setup'))?.slice(-80) ?? [],
  };
})()
`, 120000)).value;
};

const waitForFlow = async () => {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < RUN_WAIT_MS) {
    latest = await collectSummary();
    const hasCoreNodes =
      (latest?.byTemplate?.Implementer?.completed ?? 0) >= PARALLEL_COUNT &&
      (latest?.byTemplate?.Judge?.completed ?? 0) >= 1 &&
      (latest?.byTemplate?.Reviewer?.completed ?? 0) >= 1;
    const runButtonEnabled = latest?.runButtonDisabled === false;
    if (hasCoreNodes && runButtonEnabled && latest?.activeAssistantCount === 0) {
      await sleep(1500);
      return await collectSummary();
    }
    await sleep(5000);
  }
  latest = latest ?? await collectSummary();
  latest.timedOut = true;
  return latest;
};

const validateReport = (report) => {
  const errors = [];
  const summary = report.summary ?? {};
  const byTemplate = summary.byTemplate ?? {};
  const assistants = summary.assistants ?? [];
  const users = summary.users ?? [];
  const reviewerUsers = users.filter((message) => message.templateId === 'Reviewer');
  const fixerAssistants = assistants.filter((message) => message.templateId === 'Fixer');
  const reviewerAssistants = assistants.filter((message) => message.templateId === 'Reviewer');
  const judgeAssistants = assistants.filter((message) => message.templateId === 'Judge');
  const implementers = assistants.filter((message) => message.templateId === 'Implementer');
  const finalReviewer = reviewerAssistants[reviewerAssistants.length - 1] ?? null;
  const reviewerFailed = reviewerAssistants.some((message) => /verdict:\s*fail/i.test(message.content));

  if (summary.timedOut) errors.push(`flow did not finish within ${RUN_WAIT_MS}ms`);
  if (!summary.chosenFlowRunId) errors.push('no flow_run_id was observed');
  if ((byTemplate.Implementer?.completed ?? 0) < PARALLEL_COUNT) {
    errors.push(`expected ${PARALLEL_COUNT} completed Implementer nodes, saw ${byTemplate.Implementer?.completed ?? 0}`);
  }
  if ((byTemplate.Judge?.completed ?? 0) < 1) errors.push('Judge did not complete');
  if ((byTemplate.Reviewer?.completed ?? 0) < 1) errors.push('Reviewer did not complete');
  if (implementers.some((message) => message.llmModel !== 'gpt-5.4-mini')) {
    errors.push(`Implementer nodes did not all use gpt-5.4-mini: ${implementers.map((message) => message.llmModel).join(', ')}`);
  }
  if (implementers.some((message) => message.reasoningEffort !== 'low')) {
    errors.push(`Implementer nodes did not all use low reasoning effort: ${implementers.map((message) => message.reasoningEffort).join(', ')}`);
  }
  if (implementers.some((message) => message.baseCommitSha !== report.mainSha)) {
    errors.push(`Implementer base commits were not all main ${report.mainSha}: ${implementers.map((message) => message.baseCommitSha).join(', ')}`);
  }
  if (!judgeAssistants.some((message) => /selected:\s*\S+/i.test(message.content) && /verdict:\s*(pass|fail)/i.test(message.content))) {
    errors.push('Judge output did not include selected and verdict returns');
  }
  if (!finalReviewer || !/verdict:\s*pass/i.test(finalReviewer.content)) {
    errors.push('Final Reviewer output did not include verdict: pass');
  }
  if (reviewerFailed && fixerAssistants.length < 1) {
    errors.push('A reviewer failed, but no Fixer node completed');
  }
  if (REQUIRE_FIXER && fixerAssistants.length < 1) {
    errors.push('AGENTREE_TAURI_PILOT_REQUIRE_FIXER=1 but no Fixer node completed');
  }
  if (fixerAssistants.length > 0 && reviewerAssistants.length < 2) {
    errors.push('Fixer completed, but a follow-up Reviewer did not run');
  }
  if (reviewerUsers.length > 0 && !reviewerUsers.every((message) => message.content.includes('Latest fixer response, if any:'))) {
    errors.push('Reviewer prompts did not include the optional fixer response slot');
  }
  if (reviewerUsers.some((message) => message.content.includes('label: Implementer') || message.content.includes('Please implement:'))) {
    errors.push('Reviewer prompt leaked implementer node/message context');
  }
  if (fixerAssistants.length > 0) {
    const postFixReviewerUser = reviewerUsers[reviewerUsers.length - 1] ?? null;
    if (!postFixReviewerUser?.content.includes('label: Fixer')) {
      errors.push('Follow-up Reviewer prompt did not include the Fixer node context');
    }
  }
  return errors;
};

const main = async () => {
  const startedAtIso = new Date().toISOString();
  const mainSha = (await execText('git', ['-C', '..', 'rev-parse', 'main'])).trim();
  const report = {
    label: LABEL,
    startedAt: startedAtIso,
    prompt: PROMPT,
    parallelCount: PARALLEL_COUNT,
    modelKey: MODEL_KEY,
    mainSha,
    preflight: null,
    start: null,
    summary: null,
    exportStatus: null,
    validationErrors: [],
  };

  await waitForPilot();
  report.preflight = await preflight();
  if (report.preflight?.readiness?.status !== 'ready') {
    throw new Error(`Codex runtime is not ready: ${JSON.stringify(report.preflight.readiness)}`);
  }
  if (report.preflight?.appProbe?.visibility !== 'visible') {
    throw new Error(`Tauri webview is not visible: ${JSON.stringify(report.preflight.appProbe)}`);
  }

  report.start = await installAndStartFlow({ mainSha, startedAtIso });
  report.summary = await waitForFlow();
  report.exportStatus = (await pilotEval(`
(async () => {
  await window.__AGENTREE_PERF__?.stopCapture?.();
  return window.__AGENTREE_PERF__?.getExportStatus?.() ?? null;
})()
`, 120000)).value;
  report.validationErrors = validateReport(report);

  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    reportPath,
    exportPath: report.exportStatus?.exportPath ?? null,
    flowRunId: report.summary?.chosenFlowRunId ?? null,
    byTemplate: report.summary?.byTemplate ?? {},
    activeAssistantCount: report.summary?.activeAssistantCount ?? null,
    validationErrors: report.validationErrors,
  }, null, 2));

  if (report.validationErrors.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
