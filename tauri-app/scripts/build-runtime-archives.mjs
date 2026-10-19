#!/usr/bin/env node
// Builds the managed runtime archives (Node, Claude Agent SDK, Codex CLI)
// for every platform pinned in runtime-manifest.json, and rewrites the
// manifest with the resulting sha256 checksums. Run during release before
// `tauri build` so the embedded manifest carries real checksums.
//
// Usage:
//   node scripts/build-runtime-archives.mjs [--platform linux-x86_64,darwin-aarch64] [--dry-run]
//
// Archives land in src-tauri/target/runtime-archives/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  claudeSdkPnpmAddArgs,
  packagePnpmAddArgs,
  pnpmEnvironmentForRuntimeInstall,
  validateClaudeSdkInstall,
  validateClaudeSdkVersionAlignment,
} from './runtime-archive-layout.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(projectRoot, 'runtime-manifest.json');
const outputDir = path.join(projectRoot, 'src-tauri', 'target', 'runtime-archives');

const PLATFORMS = {
  'linux-x86_64': {
    nodeDist: 'linux-x64',
    codexVersionSuffix: 'linux-x64',
    codexTriple: 'x86_64-unknown-linux-musl',
    npmOs: 'linux',
    npmCpu: 'x64',
  },
  'darwin-aarch64': {
    nodeDist: 'darwin-arm64',
    codexVersionSuffix: 'darwin-arm64',
    codexTriple: 'aarch64-apple-darwin',
    npmOs: 'darwin',
    npmCpu: 'arm64',
  },
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const platformArgIndex = args.indexOf('--platform');
const requestedPlatforms =
  platformArgIndex >= 0
    ? args[platformArgIndex + 1].split(',').map((value) => value.trim())
    : Object.keys(PLATFORMS);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
validateClaudeSdkVersionAlignment(packageJson, manifest);
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

function sha256OfFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function updateFingerprintField(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function extractedTreeSha256(rootDir) {
  const entries = [];
  const visit = (directory, relativeDirectory = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolutePath = path.join(directory, name);
      entries.push({ absolutePath, relativePath });
      if (fs.lstatSync(absolutePath).isDirectory()) {
        visit(absolutePath, relativePath);
      }
    }
  };
  visit(rootDir);
  entries.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  );

  const hash = crypto.createHash('sha256');
  for (const { absolutePath, relativePath } of entries) {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isDirectory()) continue;
    updateFingerprintField(hash, relativePath);
    if (stat.isSymbolicLink()) {
      hash.update('symlink');
      updateFingerprintField(hash, fs.readlinkSync(absolutePath));
    } else if (stat.isFile()) {
      hash.update('file');
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(stat.size));
      hash.update(size);
      hash.update(fs.readFileSync(absolutePath));
    } else {
      throw new Error(`Unsupported runtime archive entry: ${absolutePath}`);
    }
  }
  return hash.digest('hex');
}

function treeSha256OfArchive(archivePath) {
  return withTempDir('agentree-runtime-fingerprint-', (tempDir) => {
    run('tar', ['-xzf', archivePath, '-C', tempDir]);
    return extractedTreeSha256(tempDir);
  });
}

function archiveName(component, version, platformKey) {
  return `agentree-runtime-${component}-${version}-${platformKey}.tar.gz`;
}

// tar with a root-content layout: entries land directly at archive root.
function packDirectory(sourceDir, destinationFile) {
  fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
  const temporaryFile = `${destinationFile}.tmp-${process.pid}`;
  try {
    run('tar', ['--no-xattrs', '-czf', temporaryFile, '-C', sourceDir, '.']);
    fs.renameSync(temporaryFile, destinationFile);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
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
    packDirectory(staging, destination);
  });
}

function buildClaudeSdkArchive(version, platformKey, destination) {
  const { npmOs, npmCpu } = PLATFORMS[platformKey];
  withTempDir('agentree-claude-sdk-', (tempDir) => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'agentree-claude-runtime', private: true }, null, 2)
    );
    run('pnpm', claudeSdkPnpmAddArgs(version, npmOs, npmCpu), {
      cwd: tempDir,
      env: pnpmEnvironmentForRuntimeInstall(),
    });
    validateClaudeSdkInstall(path.join(tempDir, 'node_modules'), { version, npmOs, npmCpu });
    const staging = path.join(tempDir, 'staging');
    fs.mkdirSync(staging, { recursive: true });
    fs.cpSync(path.join(tempDir, 'node_modules'), path.join(staging, 'node_modules'), {
      recursive: true,
    });
    packDirectory(staging, destination);
  });
}

function validateClaudeSdkArchive(version, platformKey, archivePath) {
  const { npmOs, npmCpu } = PLATFORMS[platformKey];
  withTempDir('agentree-claude-sdk-validate-', (tempDir) => {
    run('tar', ['-xzf', archivePath, '-C', tempDir]);
    validateClaudeSdkInstall(path.join(tempDir, 'node_modules'), { version, npmOs, npmCpu });
  });
}

function validateBuiltArchive(component, version, platformKey, archivePath) {
  if (component === 'claude-sdk') {
    validateClaudeSdkArchive(version, platformKey, archivePath);
  }
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
    packDirectory(vendorRoot, destination);
  });
}

const builders = {
  node: buildNodeArchive,
  'claude-sdk': buildClaudeSdkArchive,
  codex: buildCodexArchive,
};

let manifestChanged = false;
for (const [component, spec] of Object.entries(manifest.components)) {
  for (const platformKey of requestedPlatforms) {
    if (!PLATFORMS[platformKey]) {
      throw new Error(`Unknown platform key: ${platformKey}`);
    }
    if (!spec.platforms[platformKey]) continue;
    const fileName = archiveName(component, spec.version, platformKey);
    const destination = path.join(outputDir, fileName);
    const url = `${releaseBase}/${fileName}`;

    if (dryRun) {
      console.log(`[dry-run] would build ${fileName} -> ${url}`);
      continue;
    }

    if (fs.existsSync(destination) && spawnSync('tar', ['-tzf', destination]).status !== 0) {
      console.log(`Discarding invalid archive ${fileName}`);
      fs.rmSync(destination);
    }
    if (fs.existsSync(destination)) {
      try {
        validateBuiltArchive(component, spec.version, platformKey, destination);
      } catch (error) {
        console.warn(`Discarding invalid cached ${fileName}: ${error.message}`);
        fs.rmSync(destination);
      }
    }
    if (!fs.existsSync(destination)) {
      console.log(`Building ${fileName} ...`);
      builders[component](spec.version, platformKey, destination);
    } else {
      console.log(`Reusing existing ${fileName}`);
    }
    validateBuiltArchive(component, spec.version, platformKey, destination);
    const checksum = sha256OfFile(destination);
    const treeSha256 = treeSha256OfArchive(destination);
    if (
      spec.platforms[platformKey].sha256 !== checksum
      || spec.platforms[platformKey].treeSha256 !== treeSha256
      || spec.platforms[platformKey].url !== url
    ) {
      spec.platforms[platformKey] = { url, sha256: checksum, treeSha256 };
      manifestChanged = true;
    }
    console.log(`  sha256 ${checksum}`);
    console.log(`  treeSha256 ${treeSha256}`);
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
