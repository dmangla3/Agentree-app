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
  const expectedPhrase = 'It is okay to run read-only checks, tests, and builds when their caches and build output are redirected outside those symlinked directories';

  assert.match(agentRunPromptsSource, new RegExp(expectedPhrase));
  assert.match(mergeReviewSource, new RegExp(expectedPhrase));
});

test('codex adapter makes the node worktree writable without full access', () => {
  const source = readRepoFile('tauri-app/src-tauri/src/codex_adapter.rs');

  assert.match(source, /"sandbox": "workspace-write"/);
  assert.match(source, /"type": "workspaceWrite"/);
  assert.match(source, /"writableRoots": \[cwd\]/);
  assert.match(source, /"sandboxPolicy": workspace_write_sandbox_policy\(&args\.cwd\)/);
});
