import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'src');
const TESTS_DIR = join(ROOT, 'tests');
const SCRIPTS_DIR = join(ROOT, 'scripts');
const DOCS_DIR = join(ROOT, '..', 'docs');
const AUDIT_SCRIPT_PATH = 'scripts/audit-agent-run-lifecycle.mjs';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.md']);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'target',
  '.git',
]);

const normalizePath = (filePath) => relative(ROOT, filePath).replaceAll('\\', '/');

const walk = (dir) => {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    const extension = entry.slice(entry.lastIndexOf('.'));
    if (SOURCE_EXTENSIONS.has(extension)) files.push(fullPath);
  }
  return files;
};

const files = [
  ...walk(SRC_DIR),
  ...walk(TESTS_DIR),
  ...walk(SCRIPTS_DIR).filter((filePath) => normalizePath(filePath) !== AUDIT_SCRIPT_PATH),
  ...walk(DOCS_DIR).filter((filePath) => normalizePath(filePath).startsWith('../docs/runtime/')),
];

const findings = [];

const addFinding = (filePath, lineNumber, rule, message, line) => {
  findings.push({
    file: normalizePath(filePath),
    line: lineNumber,
    rule,
    message,
    text: line.trim(),
  });
};

const checkPattern = ({
  rule,
  pattern,
  message,
  allow = () => false,
}) => {
  for (const filePath of files) {
    const rel = normalizePath(filePath);
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      pattern.lastIndex = 0;
      if (allow(rel, line, index + 1)) return;
      addFinding(filePath, index + 1, rule, message, line);
    });
  }
};

checkPattern({
  rule: 'old-projection-api',
  pattern: /\b(streamingStore|StreamingMessage|useStreamingStore|streamingById|setStreamingForNode|clearStreamingForNode|clearAllStreaming|projectAgentRunToStreamingMessage|VITE_STREAMING_STORE_DEBUG)\b/g,
  message: 'Old streaming-store projection API name is forbidden. Use agentRunProjectionStore naming.',
});

checkPattern({
  rule: 'direct-projection-store-write',
  pattern: /useAgentRunProjectionStore\.getState\(\)\.(setProjectionForNode|clearProjectionForNode|clearAllProjections)\b/g,
  message: 'Projection store writes must stay inside the actor effect bridge.',
  allow: (filePath) => (
    filePath === 'src/agent-runs/agentRunEffects.ts' ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx')
  ),
});

checkPattern({
  rule: 'direct-run-status-write',
  pattern: /useRunStatusStore\.getState\(\)\.(setRunStatus|clearRunStatus|clearAllRunStatus)\b/g,
  message: 'Run status writes must stay inside the actor effect bridge or tests.',
  allow: (filePath) => (
    filePath === 'src/agent-runs/agentRunEffects.ts' ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx')
  ),
});

checkPattern({
  rule: 'bad-lifecycle-fallback',
  pattern: /\b(browser-preview-simulation|simulateBrowserAgentRun|getBrowserPreviewAgentSimulation|browser_preview_simulated_run|synthetic agent run|synthetic-active|AGENTREE_TAURI_PILOT_SYNTHETIC_ACTIVE|fake lifecycle|shadow mode|dual path)\b/gi,
  message: 'Bad lifecycle fallback detected. Fake/shadow/dual lifecycle paths are not allowed in app code or QA harnesses.',
});

const fallbackRegistry = [
  {
    name: 'required-protocol: native exit terminal event',
    patterns: [
      { file: 'src/components/ChatInput.tsx', pattern: /\bREQUIRED_PROTOCOL_FALLBACK_NATIVE_EXIT_TERMINAL_EVENT\b/ },
      { file: 'src/components/ChatInput.tsx', pattern: /\bexit_terminal_finalize\b/ },
      { file: 'src/agent-runs/agentRun.machine.test.ts', pattern: /exit terminal status/ },
    ],
  },
  {
    name: 'cache-repair: list active status server refresh',
    patterns: [
      { file: 'src/components/nodes/list/ListAssistantRow.tsx', pattern: /\bCACHE_REPAIR_LIST_ACTIVE_STATUS_REFRESH_COOLDOWN_MS\b/ },
      { file: 'src/components/nodes/list/ListAssistantRow.tsx', pattern: /\bcacheRepairListRefreshInFlightByMessageId\b/ },
    ],
  },
  {
    name: 'cache-repair: hot-send message delta bootstrap repair',
    patterns: [
      { file: 'src/hooks/useHotSendMessageDeltas.ts', pattern: /hot-send repair\/catch-up/ },
      { file: 'src/hooks/useHotSendMessageDeltas.ts', pattern: /\brepairFromBootstrap\b/ },
      { file: 'src/hooks/useHotSendMessageDeltas.ts', pattern: /query\.message-deltas\.bootstrap-repair/ },
    ],
  },
];

for (const fallback of fallbackRegistry) {
  for (const required of fallback.patterns) {
    const filePath = join(ROOT, required.file);
    const content = readFileSync(filePath, 'utf8');
    if (!required.pattern.test(content)) {
      findings.push({
        file: required.file,
        line: 1,
        rule: 'fallback-registry',
        message: `Missing classified fallback marker: ${fallback.name}`,
        text: String(required.pattern),
      });
    }
  }
}

if (findings.length > 0) {
  console.error('Agent run lifecycle audit failed:');
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
    console.error(`  ${finding.text}`);
  }
  process.exitCode = 1;
} else {
  console.log('Agent run lifecycle audit passed.');
  console.log('Classified fallbacks:');
  for (const fallback of fallbackRegistry) {
    console.log(`- ${fallback.name}`);
  }
}
