import assert from 'node:assert/strict';
import test from 'node:test';

import { runtimeManifestArtifacts } from './runtime-manifest-artifacts.mjs';

test('manifest artifacts preserve immutable URLs and exact local archive names', () => {
  const checksum = 'a'.repeat(64);
  const fileName = 'agentree-runtime-node-22.21.1-linux-x86_64.tar.gz';
  const manifest = {
    components: {
      node: {
        version: '22.21.1',
        platforms: {
          'linux-x86_64': {
            sha256: checksum,
            url: `https://downloads.example/releases/runtime/sha256/${checksum}/${fileName}`,
          },
        },
      },
    },
  };

  assert.deepEqual(runtimeManifestArtifacts(manifest, '/tmp/archives', 'linux-x86_64'), [
    {
      component: 'node',
      platform: 'linux-x86_64',
      sha256: checksum,
      fileName,
      localPath: `/tmp/archives/${fileName}`,
      r2Object: `agentree-downloads/releases/runtime/sha256/${checksum}/${fileName}`,
      url: `https://downloads.example/releases/runtime/sha256/${checksum}/${fileName}`,
    },
  ]);
});

test('manifest artifacts reject URLs outside the immutable runtime namespace', () => {
  const manifest = {
    components: {
      node: {
        platforms: {
          linux: {
            sha256: 'a'.repeat(64),
            url: 'https://downloads.example/unrelated/archive.tar.gz',
          },
        },
      },
    },
  };
  assert.throws(() => runtimeManifestArtifacts(manifest, '/tmp'), /not checksum-addressed/);
});
