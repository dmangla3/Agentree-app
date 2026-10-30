import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  lockedRuntimePnpmInstallArgs,
  packagePnpmAddArgs,
  pnpmEnvironmentForRuntimeInstall,
  pruneNonTargetClaudeNativePackages,
  validateClaudeSdkInstall,
  validateClaudeSdkVersionAlignment,
  validateOpenCodeSdkInstall,
  validateOpenCodeSdkVersionAlignment,
  validateRuntimePackageVersionAlignment,
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

test('locked runtime installs use the committed cross-platform dependency graph', () => {
  const args = lockedRuntimePnpmInstallArgs('linux', 'x64');
  assert.ok(args.includes('--frozen-lockfile'));
  assert.ok(args.includes('--prod'));
  assert.ok(args.includes('--ignore-workspace'));
  assert.ok(!args.includes('--no-optional'));
  assert.ok(!args.includes('--force'));
  assert.ok(args.includes('--os=linux'));
  assert.ok(args.includes('--cpu=x64'));
});

test('Claude runtime staging prunes non-target native packages', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentree-runtime-prune-'));
  const anthropicDir = path.join(root, 'node_modules', '@anthropic-ai');
  for (const name of [
    'claude-agent-sdk',
    'claude-agent-sdk-linux-x64',
    'claude-agent-sdk-linux-x64-musl',
    'claude-agent-sdk-darwin-arm64',
  ]) {
    fs.mkdirSync(path.join(anthropicDir, name), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  pruneNonTargetClaudeNativePackages(path.join(root, 'node_modules'), {
    npmOs: 'linux',
    npmCpu: 'x64',
  });

  assert.ok(fs.existsSync(path.join(anthropicDir, 'claude-agent-sdk')));
  assert.ok(fs.existsSync(path.join(anthropicDir, 'claude-agent-sdk-linux-x64')));
  assert.ok(!fs.existsSync(path.join(anthropicDir, 'claude-agent-sdk-linux-x64-musl')));
  assert.ok(!fs.existsSync(path.join(anthropicDir, 'claude-agent-sdk-darwin-arm64')));
});

test('runtime package installs use a portable hoisted dependency layout', () => {
  for (const args of [
    lockedRuntimePnpmInstallArgs('linux', 'x64'),
    packagePnpmAddArgs('@openai/codex@0.144.1-linux-x64', 'linux', 'x64'),
  ]) {
    assert.ok(args.includes('--config.node-linker=hoisted'));
  }
});

test('locked runtime packages cannot drift from the manifest', () => {
  const packageJson = { dependencies: { '@opencode-ai/sdk': '1.18.3' } };
  assert.doesNotThrow(() =>
    validateRuntimePackageVersionAlignment(packageJson, 'opencode', '1.18.3')
  );
  assert.throws(
    () => validateRuntimePackageVersionAlignment(packageJson, 'opencode', '1.18.2'),
    /build lock version drift/
  );
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

  const unexpectedNativeDir = path.join(
    fixture.nodeModules,
    '@anthropic-ai',
    'claude-agent-sdk-linux-x64-musl',
  );
  fs.mkdirSync(unexpectedNativeDir, { recursive: true });
  assert.throws(
    () => validateClaudeSdkInstall(fixture.nodeModules, {
      version: '0.3.207',
      npmOs: 'linux',
      npmCpu: 'x64',
    }),
    /non-target native packages/,
  );
  fs.rmSync(unexpectedNativeDir, { recursive: true, force: true });

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

test('OpenCode project and managed runtime SDK versions cannot drift', () => {
  const packageJson = {
    dependencies: { '@opencode-ai/sdk': '1.18.3' },
  };
  const runtimeManifest = {
    components: { opencode: { version: '1.18.3' } },
  };
  assert.doesNotThrow(() => validateOpenCodeSdkVersionAlignment(packageJson, runtimeManifest));

  runtimeManifest.components.opencode.version = '1.18.2';
  assert.throws(
    () => validateOpenCodeSdkVersionAlignment(packageJson, runtimeManifest),
    /version drift/
  );
});

test('OpenCode runtime layout requires the pinned SDK package', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentree-opencode-layout-'));
  const nodeModules = path.join(root, 'node_modules');
  const sdkDir = path.join(nodeModules, '@opencode-ai', 'sdk');
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ version: '1.18.3' }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.doesNotThrow(() => validateOpenCodeSdkInstall(nodeModules, '1.18.3'));
  assert.throws(() => validateOpenCodeSdkInstall(nodeModules, '1.18.2'), /version mismatch/);
  fs.rmSync(path.join(sdkDir, 'package.json'));
  assert.throws(() => validateOpenCodeSdkInstall(nodeModules, '1.18.3'), /incomplete/);
});
