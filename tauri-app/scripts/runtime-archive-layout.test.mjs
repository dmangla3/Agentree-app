import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  claudeSdkPnpmAddArgs,
  pnpmEnvironmentForRuntimeInstall,
  validateClaudeSdkInstall,
  validateClaudeSdkVersionAlignment,
} from './runtime-archive-layout.mjs';

function sdkFixture(version = '0.3.207') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentree-runtime-layout-'));
  const nodeModules = path.join(root, 'node_modules');
  const sdkDir = path.join(nodeModules, '@anthropic-ai', 'claude-agent-sdk');
  const nativeDir = path.join(nodeModules, '@anthropic-ai', 'claude-agent-sdk-linux-x64');
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'sdk.mjs'), 'export {};\n');
  fs.writeFileSync(
    path.join(sdkDir, 'package.json'),
    JSON.stringify({
      version,
      optionalDependencies: { '@anthropic-ai/claude-agent-sdk-linux-x64': version },
    })
  );
  fs.writeFileSync(path.join(nativeDir, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(nativeDir, 'claude'), '#!/bin/sh\n');
  fs.chmodSync(path.join(nativeDir, 'claude'), 0o755);
  return { root, nodeModules, nativeDir };
}

test('Claude runtime install explicitly adds only the target native dependency', () => {
  const args = claudeSdkPnpmAddArgs('0.3.207', 'linux', 'x64');
  assert.ok(args.includes('--prod'));
  assert.ok(args.includes('--no-optional'));
  assert.ok(args.includes('--os=linux'));
  assert.ok(args.includes('--cpu=x64'));
  assert.ok(args.includes('@anthropic-ai/claude-agent-sdk@0.3.207'));
  assert.ok(args.includes('@anthropic-ai/claude-agent-sdk-linux-x64@0.3.207'));
});

test('Claude runtime install ignores inherited package-manager optional omission', () => {
  const env = pnpmEnvironmentForRuntimeInstall({
    NPM_CONFIG_OMIT: 'optional',
    npm_config_optional: 'false',
    PNPM_CONFIG_OMIT: 'optional',
    NPM_CONFIG_CACHE: '/tmp/agentree-npm-cache',
  });
  assert.equal(env.NPM_CONFIG_OMIT, undefined);
  assert.equal(env.npm_config_optional, undefined);
  assert.equal(env.PNPM_CONFIG_OMIT, undefined);
  assert.equal(env.NPM_CONFIG_CACHE, '/tmp/agentree-npm-cache');
});

test('Claude project and managed runtime versions cannot drift', () => {
  const packageJson = {
    dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.207' },
  };
  const runtimeManifest = {
    components: { 'claude-sdk': { version: '0.3.207' } },
  };
  assert.doesNotThrow(() => validateClaudeSdkVersionAlignment(packageJson, runtimeManifest));

  runtimeManifest.components['claude-sdk'].version = '0.2.107';
  assert.throws(
    () => validateClaudeSdkVersionAlignment(packageJson, runtimeManifest),
    /version drift/
  );
});

test('Claude runtime layout requires the platform-native executable', (t) => {
  const fixture = sdkFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(
    validateClaudeSdkInstall(fixture.nodeModules, {
      version: '0.3.207',
      npmOs: 'linux',
      npmCpu: 'x64',
    }),
    path.join(fixture.nativeDir, 'claude')
  );

  fs.rmSync(path.join(fixture.nativeDir, 'claude'));
  assert.throws(
    () =>
      validateClaudeSdkInstall(fixture.nodeModules, {
        version: '0.3.207',
        npmOs: 'linux',
        npmCpu: 'x64',
      }),
    /native executable missing/
  );
});
