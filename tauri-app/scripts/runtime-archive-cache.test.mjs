import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  archiveFileName,
  archiveUrl,
  packDirectoryDeterministically,
  runtimeBuildKey,
} from './runtime-archive-cache.mjs';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('runtime build keys cover every input that can change archive contents', () => {
  const input = {
    component: 'opencode',
    version: '1.18.3',
    platform: 'linux-x86_64',
    platformConfig: { npmOs: 'linux', npmCpu: 'x64' },
    bundledVersions: { ripgrep: '15.1.0' },
    recipeSha256: 'a'.repeat(64),
    dependencyLockSha256: 'b'.repeat(64),
  };
  const original = runtimeBuildKey(input);

  assert.equal(original, runtimeBuildKey({ ...input }));
  for (const changed of [
    { version: '1.18.4' },
    { platform: 'darwin-aarch64' },
    { platformConfig: { npmOs: 'darwin', npmCpu: 'arm64' } },
    { bundledVersions: { ripgrep: '15.2.0' } },
    { recipeSha256: 'c'.repeat(64) },
    { dependencyLockSha256: 'd'.repeat(64) },
  ]) {
    assert.notEqual(original, runtimeBuildKey({ ...input, ...changed }));
  }
});

test('runtime URLs are immutable while local filenames stay compatible with smoke tooling', () => {
  const checksum = 'f'.repeat(64);
  const fileName = archiveFileName('claude-sdk', '0.3.207', 'darwin-aarch64');

  assert.equal(fileName, 'agentree-runtime-claude-sdk-0.3.207-darwin-aarch64.tar.gz');
  assert.equal(
    archiveUrl('https://downloads.example/releases/runtime/', fileName, checksum),
    `https://downloads.example/releases/runtime/sha256/${checksum}/${fileName}`,
  );
});

test('runtime archives are byte-for-byte deterministic across source mtimes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentree-runtime-pack-test-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(path.join(first, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(second, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(first, 'bin', 'tool'), '#!/bin/sh\necho ok\n');
  fs.writeFileSync(path.join(second, 'bin', 'tool'), '#!/bin/sh\necho ok\n');
  fs.chmodSync(path.join(first, 'bin', 'tool'), 0o755);
  fs.chmodSync(path.join(second, 'bin', 'tool'), 0o755);
  fs.utimesSync(path.join(first, 'bin', 'tool'), new Date(1_000), new Date(1_000));
  fs.utimesSync(path.join(second, 'bin', 'tool'), new Date(2_000_000), new Date(2_000_000));
  const firstArchive = path.join(root, 'first.tar.gz');
  const secondArchive = path.join(root, 'second.tar.gz');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  packDirectoryDeterministically(first, firstArchive);
  packDirectoryDeterministically(second, secondArchive);

  assert.equal(sha256(firstArchive), sha256(secondArchive));
  const listing = spawnSync('tar', ['-tzf', firstArchive], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split('\n'), ['./bin/', './bin/tool']);
});
