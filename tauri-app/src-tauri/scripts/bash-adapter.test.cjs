const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const adapterPath = path.join(__dirname, 'bash-adapter.cjs');

test('does not write startup diagnostics to stderr for successful commands', () => {
  const result = spawnSync(process.execPath, [adapterPath, '-p', 'echo ok'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /"content":"ok\\n"/);
});
