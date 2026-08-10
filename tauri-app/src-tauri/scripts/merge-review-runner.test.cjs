const test = require('node:test');
const assert = require('node:assert/strict');

const { selectCodexPythonCommand } = require('./merge-review-runner.cjs');

test('selectCodexPythonCommand prefers PYTHON_BIN when provided', () => {
  assert.equal(
    selectCodexPythonCommand({ PYTHON_BIN: '/opt/homebrew/bin/python3.12' }),
    '/opt/homebrew/bin/python3.12',
  );
});

test('selectCodexPythonCommand falls back to python3', () => {
  assert.equal(selectCodexPythonCommand({}), 'python3');
});
