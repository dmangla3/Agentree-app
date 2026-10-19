const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');

const readRepoFile = (relativePath) => (
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
);

test('vite cache helper uses the agent sandbox and otherwise stays off system temp', () => {
  const source = readRepoFile('tauri-app/vite.config.cjs');
  const { osCacheDir, viteCacheDir } = require(path.join(
    repoRoot,
    'tauri-app/scripts/vite-cache-dir.cjs',
  ));

  assert.equal(
    viteCacheDir({ AGENT_SANDBOX: '/cache/agentree/agents/run-1' }),
    path.join('/cache/agentree/agents/run-1', 'vite-cache'),
  );
  assert.equal(
    viteCacheDir({}),
    path.join(osCacheDir({}), 'agentree', 'vite-cache'),
  );
  assert.match(source, /viteCacheDir\(\)/);
  assert.match(source, /cacheDir:/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'tauri-app/vite.config.ts')), false);
});

test('dependency guard prompts allow sandboxed test and build commands', () => {
  const defaultPrompts = JSON.parse(
    readRepoFile('tauri-app/src/lib/prompts/defaultPromptDefinitions.json'),
  );
  const mergeReviewSource = readRepoFile('tauri-app/src-tauri/scripts/merge-review-runner.cjs');
  const expectedPhrase =
    'Checks, tests, and builds are okay when their writes stay in those Agentree-managed paths';
  const dependencyGuard = defaultPrompts.find(({ id }) => id === 'dependency_guard');

  assert.match(dependencyGuard.defaultText, new RegExp(expectedPhrase));
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

test('full access keeps runtime layout while skipping Agentree command guards', () => {
  const source = readRepoFile('tauri-app/src-tauri/src/agents.rs');

  assert.match(source, /agent_args_request_full_access\(&args\)/);
  assert.match(source, /command\.env\("PATH", crate::command_guards::build_agent_path\(\)\)/);
  assert.match(source, /apply_agent_runtime_layout/);
  assert.match(source, /window\[1\] == "full-access" \|\| window\[1\] == "bypassPermissions"/);
});
