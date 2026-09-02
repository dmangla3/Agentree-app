const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCodexCommand } = require('./merge-review-runner.cjs');

test('buildCodexCommand uses Agentree Rust adapter command', () => {
  assert.deepEqual(
    buildCodexCommand({
      codexAdapterProgram: '/Applications/Agentree.app/Contents/MacOS/agentree',
      codexAdapterArgsPrefix: ['--agentree-codex-adapter'],
      cliArgs: '--model gpt-5.4 --reasoning-effort high --permission-mode auto',
    }, 'review this'),
    {
      program: '/Applications/Agentree.app/Contents/MacOS/agentree',
      args: [
        '--agentree-codex-adapter',
        '--model',
        'gpt-5.4',
        '--reasoning-effort',
        'high',
        '--permission-mode',
        'auto',
        'review this',
      ],
    },
  );
});

test('buildCodexCommand fails without adapter program', () => {
  assert.throws(
    () => buildCodexCommand({ cliArgs: '' }, 'review this'),
    /Missing Codex adapter program/,
  );
});
