import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { viteCacheDir } = require('./vite-cache-dir.cjs');

test('uses an explicit worktree cache before agent and shared cache locations', () => {
  assert.equal(viteCacheDir({
    AGENTREE_VITE_CACHE_DIR: '/tmp/worktree-vite-cache',
    AGENT_SANDBOX: '/tmp/agent-sandbox',
  }), '/tmp/worktree-vite-cache');
});
