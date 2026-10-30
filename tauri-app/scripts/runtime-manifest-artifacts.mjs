#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { archiveFileNameFromUrl } from './runtime-archive-cache.mjs';

export function runtimeManifestArtifacts(manifest, archivesDir, platform = null) {
  const artifacts = [];
  for (const [component, spec] of Object.entries(manifest.components ?? {})) {
    for (const [platformKey, archive] of Object.entries(spec.platforms ?? {})) {
      if (platform && platformKey !== platform) continue;
      if (!archive.url || !archive.sha256) {
        throw new Error(`Incomplete ${component} runtime artifact for ${platformKey}`);
      }
      const url = new URL(archive.url);
      const immutablePrefix = `/releases/runtime/sha256/${archive.sha256}/`;
      if (!url.pathname.startsWith(immutablePrefix)) {
        throw new Error(`Runtime URL is not checksum-addressed: ${archive.url}`);
      }
      const fileName = archiveFileNameFromUrl(archive.url);
      artifacts.push({
        component,
        platform: platformKey,
        sha256: archive.sha256,
        fileName,
        localPath: path.resolve(archivesDir, fileName),
        r2Object: `agentree-downloads${url.pathname}`,
        url: archive.url,
      });
    }
  }
  return artifacts;
}

function argumentValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = path.resolve(
    argumentValue('--manifest', path.join(projectRoot, 'runtime-manifest.json'))
  );
  const archivesDir = path.resolve(
    argumentValue('--archives-dir', path.join(projectRoot, 'src-tauri', 'target', 'runtime-archives'))
  );
  const platform = argumentValue('--platform');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const artifact of runtimeManifestArtifacts(manifest, archivesDir, platform)) {
    console.log(
      [artifact.sha256, artifact.fileName, artifact.localPath, artifact.r2Object, artifact.url].join('\t')
    );
  }
}
