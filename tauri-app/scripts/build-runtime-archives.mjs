#!/usr/bin/env node
// Builds the managed runtime archives (Node, provider SDKs, and provider CLIs)
// for every platform pinned in runtime-manifest.json, and rewrites the
// manifest with the resulting sha256 checksums. Run during release before
// `tauri build` so the embedded manifest carries real checksums.
//
// Usage:
//   node scripts/build-runtime-archives.mjs [--platform linux-x86_64,darwin-aarch64]
//     [--component opencode] [--manifest path] [--output-dir path] [--dry-run]
//
// Archives land in src-tauri/target/runtime-archives/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
import {
  archiveFileName,
  archiveUrl,
  packDirectoryDeterministically,
  runtimeBuildKey,
  sha256OfFile,
} from './runtime-archive-cache.mjs';
import { runtimeTreeSha256 } from './runtime-tree-fingerprint.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argumentValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const manifestPath = path.resolve(argumentValue('--manifest', path.join(projectRoot, 'runtime-manifest.json')));
const outputDir = path.resolve(
  argumentValue('--output-dir', path.join(projectRoot, 'src-tauri', 'target', 'runtime-archives'))
);
const sharedCacheDir = path.resolve(
  process.env.AGENTREE_RUNTIME_CACHE_DIR
    || path.join(os.homedir(), '.cache', 'agentree', 'runtime-archives')
);
const recipeFiles = [
  fileURLToPath(import.meta.url),
  path.join(projectRoot, 'scripts', 'runtime-archive-cache.mjs'),
  path.join(projectRoot, 'scripts', 'runtime-archive-layout.mjs'),
];

const PLATFORMS = {
  'linux-x86_64': {
    nodeDist: 'linux-x64',
    codexVersionSuffix: 'linux-x64',
    codexTriple: 'x86_64-unknown-linux-musl',
    npmOs: 'linux',
    npmCpu: 'x64',
    opencodeAsset: 'opencode-linux-x64.tar.gz',
    ripgrepPlatform: 'x86_64-unknown-linux-musl',
  },
  'darwin-aarch64': {
    nodeDist: 'darwin-arm64',
    codexVersionSuffix: 'darwin-arm64',
    codexTriple: 'aarch64-apple-darwin',
    npmOs: 'darwin',
    npmCpu: 'arm64',
    opencodeAsset: 'opencode-darwin-arm64.zip',
    ripgrepPlatform: 'aarch64-apple-darwin',
  },
};

const dryRun = args.includes('--dry-run');
const platformArgIndex = args.indexOf('--platform');
const requestedPlatforms =
  platformArgIndex >= 0
    ? args[platformArgIndex + 1].split(',').map((value) => value.trim())
    : Object.keys(PLATFORMS);
const componentArgIndex = args.indexOf('--component');
const requestedComponents =
  componentArgIndex >= 0
    ? new Set(args[componentArgIndex + 1].split(',').map((value) => value.trim()))
    : null;

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
validateClaudeSdkVersionAlignment(packageJson, manifest);
validateOpenCodeSdkVersionAlignment(packageJson, manifest);
const releaseBase = manifest.releaseBase.replace(/\/$/, '');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

function sha256OfFiles(filePaths) {
  const hash = crypto.createHash('sha256');
  for (const filePath of filePaths) {
    hash.update(path.relative(projectRoot, filePath));
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function runtimePackageDir(component) {
  return path.join(
    projectRoot,
    'runtime-packages',
    component === 'claude-sdk' ? 'claude' : component,
  );
}

function dependencyLockSha256(component) {
  if (!['claude-sdk', 'opencode'].includes(component)) return null;
  const packageDir = runtimePackageDir(component);
  return sha256OfFiles([
    path.join(packageDir, 'package.json'),
    path.join(packageDir, 'pnpm-lock.yaml'),
  ]);
}

function buildKeyFor(component, spec, platformKey) {
  return runtimeBuildKey({
    component,
    version: spec.version,
    platform: platformKey,
    platformConfig: PLATFORMS[platformKey],
    bundledVersions:
      component === 'opencode' ? { ripgrep: spec.bundledRipgrepVersion } : {},
    recipeSha256: sha256OfFiles(recipeFiles),
    dependencyLockSha256: dependencyLockSha256(component),
  });
}

function cachePath(checksum, fileName) {
  return path.join(sharedCacheDir, 'sha256', checksum, fileName);
}

function copyAtomically(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.rmSync(temporary, { force: true });
  try {
    try {
      fs.linkSync(source, temporary);
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      fs.copyFileSync(source, temporary);
    }
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function validChecksum(filePath, expected) {
  return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()
    && sha256OfFile(filePath) === expected;
}

function hydrateArchive(platformSpec, expectedBuildKey, fileName, destination) {
  if (
    platformSpec?.buildKey !== expectedBuildKey
    || !/^[a-f0-9]{64}$/.test(platformSpec?.sha256 ?? '')
    || !platformSpec?.url
  ) {
    return false;
  }

  const expectedChecksum = platformSpec.sha256;
  if (validChecksum(destination, expectedChecksum)) return true;
  fs.rmSync(destination, { force: true });

  const cached = cachePath(expectedChecksum, fileName);
  if (validChecksum(cached, expectedChecksum)) {
    copyAtomically(cached, destination);
    return true;
  }
  fs.rmSync(cached, { force: true });

  const temporary = `${cached}.download-${process.pid}`;
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  try {
    console.log(`Downloading cached ${fileName} ...`);
    downloadTo(platformSpec.url, temporary);
    if (!validChecksum(temporary, expectedChecksum)) {
      throw new Error(`downloaded checksum does not match ${expectedChecksum}`);
    }
    fs.renameSync(temporary, cached);
    copyAtomically(cached, destination);
    return true;
  } catch (error) {
    console.warn(`Remote cache unavailable for ${fileName}; rebuilding: ${error.message}`);
    return false;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function storeInSharedCache(archivePath, checksum, fileName) {
  const cached = cachePath(checksum, fileName);
  if (!validChecksum(cached, checksum)) copyAtomically(archivePath, cached);
}

function withTempDir(prefix, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return work(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function downloadTo(url, destination) {
  run('curl', ['-fsSL', '--retry', '3', '-o', destination, url]);
}

function stageNodeModules(nodeModulesDir, tempDir) {
  const staging = path.join(tempDir, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  fs.cpSync(nodeModulesDir, path.join(staging, 'node_modules'), { recursive: true });
  // pnpm generates absolute command links into its temporary install directory.
  // Runtime SDK imports do not use them, and retaining them makes the extracted
  // tree depend on a path that is deleted as soon as packaging completes.
  fs.rmSync(path.join(staging, 'node_modules', '.bin'), { recursive: true, force: true });
  return staging;
}

function installLockedRuntimePackage(component, version, npmOs, npmCpu, tempDir) {
  const packageDir = runtimePackageDir(component);
  const runtimePackageJson = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
  );
  validateRuntimePackageVersionAlignment(runtimePackageJson, component, version);
  fs.copyFileSync(path.join(packageDir, 'package.json'), path.join(tempDir, 'package.json'));
  fs.copyFileSync(path.join(packageDir, 'pnpm-lock.yaml'), path.join(tempDir, 'pnpm-lock.yaml'));
  run('pnpm', lockedRuntimePnpmInstallArgs(npmOs, npmCpu), {
    cwd: tempDir,
    env: pnpmEnvironmentForRuntimeInstall(),
  });
}

function buildNodeArchive(version, platformKey, destination) {
  const dist = PLATFORMS[platformKey].nodeDist;
  withTempDir('agentree-node-', (tempDir) => {
    const tarball = path.join(tempDir, 'node.tar.gz');
    downloadTo(`https://nodejs.org/dist/v${version}/node-v${version}-${dist}.tar.gz`, tarball);
    run('tar', ['-xzf', tarball, '-C', tempDir]);
    const extracted = path.join(tempDir, `node-v${version}-${dist}`);
    // Only the node binary is needed; package-manager tooling and docs would triple the size.
    const staging = path.join(tempDir, 'staging');
    fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
    fs.copyFileSync(path.join(extracted, 'bin', 'node'), path.join(staging, 'bin', 'node'));
    fs.chmodSync(path.join(staging, 'bin', 'node'), 0o755);
    packDirectoryDeterministically(staging, destination);
  });
}

function buildClaudeSdkArchive(version, platformKey, destination) {
  const { npmOs, npmCpu } = PLATFORMS[platformKey];
  withTempDir('agentree-claude-sdk-', (tempDir) => {
    installLockedRuntimePackage('claude-sdk', version, npmOs, npmCpu, tempDir);
    pruneNonTargetClaudeNativePackages(path.join(tempDir, 'node_modules'), { npmOs, npmCpu });
    validateClaudeSdkInstall(path.join(tempDir, 'node_modules'), { version, npmOs, npmCpu });
    const staging = stageNodeModules(path.join(tempDir, 'node_modules'), tempDir);
    packDirectoryDeterministically(staging, destination);
  });
}

function buildCodexArchive(version, platformKey, destination) {
  const { codexVersionSuffix, codexTriple } = PLATFORMS[platformKey];
  // Platform binaries are published as version aliases of @openai/codex,
  // e.g. @openai/codex@0.139.0-linux-x64.
  const spec = `@openai/codex@${version}-${codexVersionSuffix}`;
  withTempDir('agentree-codex-', (tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'agentree-codex-runtime', private: true }, null, 2)
    );
    const { npmOs, npmCpu } = PLATFORMS[platformKey];
    run('pnpm', packagePnpmAddArgs(spec, npmOs, npmCpu), { cwd: tempDir });
    const vendorRoot = path.join(tempDir, 'node_modules', '@openai', 'codex', 'vendor', codexTriple);
    if (!fs.existsSync(path.join(vendorRoot, 'bin', 'codex'))) {
      throw new Error(`codex binary missing in ${spec} at ${vendorRoot}`);
    }
    // Ship the whole triple dir contents: codex expects its sibling
    // codex-resources/ and codex-path/ helpers next to bin/.
    packDirectoryDeterministically(vendorRoot, destination);
  });
}

function buildOpenCodeArchive(version, platformKey, destination, spec) {
  const { npmOs, npmCpu, opencodeAsset: asset, ripgrepPlatform } = PLATFORMS[platformKey];
  const ripgrepVersion = spec.bundledRipgrepVersion;
  if (!ripgrepVersion) throw new Error('opencode.bundledRipgrepVersion is required');
  withTempDir('agentree-opencode-', (tempDir) => {
    const archive = path.join(tempDir, asset);
    downloadTo(`https://github.com/anomalyco/opencode/releases/download/v${version}/${asset}`, archive);
    if (asset.endsWith('.zip')) run('unzip', ['-q', archive, '-d', tempDir]);
    else run('tar', ['-xzf', archive, '-C', tempDir]);
    const binary = path.join(tempDir, 'opencode');
    if (!fs.existsSync(binary)) throw new Error(`opencode binary missing from ${asset}`);

    const ripgrepName = `ripgrep-${ripgrepVersion}-${ripgrepPlatform}`;
    const ripgrepArchive = path.join(tempDir, `${ripgrepName}.tar.gz`);
    downloadTo(
      `https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepVersion}/${ripgrepName}.tar.gz`,
      ripgrepArchive
    );
    run('tar', ['-xzf', ripgrepArchive, '-C', tempDir]);
    const ripgrepBinary = path.join(tempDir, ripgrepName, 'rg');
    if (!fs.existsSync(ripgrepBinary)) throw new Error(`ripgrep binary missing from ${ripgrepName}.tar.gz`);

    installLockedRuntimePackage('opencode', version, npmOs, npmCpu, tempDir);
    validateOpenCodeSdkInstall(path.join(tempDir, 'node_modules'), version);

    const staging = stageNodeModules(path.join(tempDir, 'node_modules'), tempDir);
    fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
    fs.copyFileSync(binary, path.join(staging, 'bin', 'opencode'));
    fs.copyFileSync(ripgrepBinary, path.join(staging, 'bin', 'rg'));
    fs.chmodSync(path.join(staging, 'bin', 'opencode'), 0o755);
    fs.chmodSync(path.join(staging, 'bin', 'rg'), 0o755);
    packDirectoryDeterministically(staging, destination);
  });
}

const builders = {
  node: buildNodeArchive,
  'claude-sdk': buildClaudeSdkArchive,
  codex: buildCodexArchive,
  opencode: buildOpenCodeArchive,
};

if (requestedComponents) {
  for (const component of requestedComponents) {
    if (!builders[component]) throw new Error(`Unknown runtime component: ${component}`);
  }
}

let manifestChanged = false;
const referencedArchiveNames = new Set();
for (const [component, spec] of Object.entries(manifest.components)) {
  if (requestedComponents && !requestedComponents.has(component)) continue;
  for (const platformKey of requestedPlatforms) {
    if (!PLATFORMS[platformKey]) {
      throw new Error(`Unknown platform key: ${platformKey}`);
    }
    if (!spec.platforms[platformKey]) continue;
    const fileName = archiveFileName(component, spec.version, platformKey);
    referencedArchiveNames.add(fileName);
    const destination = path.join(outputDir, fileName);
    const buildKey = buildKeyFor(component, spec, platformKey);
    const previousPlatformSpec = spec.platforms[platformKey];

    if (dryRun) {
      const action = previousPlatformSpec?.buildKey === buildKey ? 'reuse' : 'build';
      console.log(`[dry-run] would ${action} ${fileName} (buildKey ${buildKey})`);
      continue;
    }

    let reused = hydrateArchive(previousPlatformSpec, buildKey, fileName, destination);
    let treeSha256 = null;
    if (reused && previousPlatformSpec.treeSha256) {
      treeSha256 = runtimeTreeSha256(projectRoot, component, destination);
      if (treeSha256 !== previousPlatformSpec.treeSha256) {
        console.warn(`Cached ${fileName} has an unexpected extracted fingerprint; rebuilding`);
        fs.rmSync(destination, { force: true });
        fs.rmSync(cachePath(previousPlatformSpec.sha256, fileName), { force: true });
        reused = false;
        treeSha256 = null;
      }
    }

    if (!reused) {
      console.log(`Building ${fileName} ...`);
      builders[component](spec.version, platformKey, destination, spec);
    } else {
      console.log(`Reusing verified ${fileName}`);
    }
    const checksum = sha256OfFile(destination);
    treeSha256 ??= runtimeTreeSha256(projectRoot, component, destination);
    const url = archiveUrl(releaseBase, fileName, checksum);
    storeInSharedCache(destination, checksum, fileName);
    if (
      spec.platforms[platformKey].sha256 !== checksum
      || spec.platforms[platformKey].treeSha256 !== treeSha256
      || spec.platforms[platformKey].url !== url
      || spec.platforms[platformKey].buildKey !== buildKey
    ) {
      spec.platforms[platformKey] = { url, sha256: checksum, treeSha256, buildKey };
      manifestChanged = true;
    }
    console.log(`  sha256 ${checksum}`);
    console.log(`  treeSha256 ${treeSha256}`);
  }
}

if (!dryRun && !requestedComponents && requestedPlatforms.length === Object.keys(PLATFORMS).length) {
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (
      entry.isFile()
      && entry.name.startsWith('agentree-runtime-')
      && entry.name.endsWith('.tar.gz')
      && !referencedArchiveNames.has(entry.name)
    ) {
      fs.rmSync(path.join(outputDir, entry.name));
      console.log(`Removed stale runtime archive ${entry.name}`);
    }
  }
}

if (dryRun) {
  console.log('[dry-run] manifest untouched');
} else if (manifestChanged) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated ${manifestPath}`);
} else {
  console.log('Manifest already up to date');
}
console.log(`Archives in ${outputDir}`);
