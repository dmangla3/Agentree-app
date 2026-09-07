const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');

const readRepoFile = (relativePath) => (
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
);

test('vite config sends cache output to the agent sandbox when available', () => {
  const source = readRepoFile('tauri-app/vite.config.cjs');

  assert.match(source, /process\.env\.AGENT_SANDBOX/);
  assert.match(source, /cacheDir:/);
  assert.match(source, /vite-cache/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'tauri-app/vite.config.ts')), false);
});

test('dependency guard prompts allow sandboxed test and build commands', () => {
  const agentRunPromptsSource = readRepoFile('tauri-app/src/lib/prompts/agentRunPrompts.ts');
  const mergeReviewSource = readRepoFile('tauri-app/src-tauri/scripts/merge-review-runner.cjs');
  const expectedPhrase = 'Checks, tests, and builds are okay when their writes stay in those sandbox paths';

  assert.match(agentRunPromptsSource, new RegExp(expectedPhrase));
  assert.match(mergeReviewSource, new RegExp(expectedPhrase));
});

test('codex adapter maps composer permission modes into sandbox policies', () => {
  const source = readRepoFile('tauri-app/src-tauri/src/codex_adapter.rs');

  assert.match(source, /codex_sandbox_name\(permission_mode\)/);
  assert.match(source, /"type": "workspaceWrite"/);
  assert.match(source, /"writableRoots": \[cwd\]/);
  assert.match(source, /"networkAccess": true/);
  assert.match(source, /"type": "dangerFullAccess"/);
  assert.match(source, /"sandboxPolicy": sandbox_policy/);
});

test('full access agent runs skip Agentree command guards', () => {
  const source = readRepoFile('tauri-app/src-tauri/src/agents.rs');

  assert.match(source, /agent_args_request_full_access\(&args\)/);
  assert.match(source, /command\.env\("PATH", crate::command_guards::build_agent_path\(\)\)/);
  assert.match(source, /window\[1\] == "full-access" \|\| window\[1\] == "bypassPermissions"/);
});
