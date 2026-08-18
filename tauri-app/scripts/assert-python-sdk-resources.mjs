import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sdkDir = path.join('src-tauri', 'python-sdk');
const coreDir = path.join(sdkDir, 'pydantic_core');
const codexInit = path.join(sdkDir, 'codex_app_server', '__init__.py');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(codexInit)) {
  fail(`Missing bundled Codex SDK package at ${codexInit}`);
}

if (!fs.existsSync(coreDir)) {
  fail(`Missing pydantic_core package at ${coreDir}`);
}

const nativeExtensions = fs
  .readdirSync(coreDir)
  .filter((entry) => /^_pydantic_core\.cpython-\d+-darwin\.so$/.test(entry));

if (nativeExtensions.length === 0) {
  fail(`Missing pydantic_core native extension in ${coreDir}`);
}

if (process.platform !== 'darwin') {
  console.log(`Found ${nativeExtensions.length} pydantic_core native extension(s).`);
  process.exit(0);
}

for (const extension of nativeExtensions) {
  const extensionPath = path.join(coreDir, extension);
  const result = spawnSync('file', [extensionPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`Unable to inspect ${extensionPath}: ${result.stderr || result.stdout}`);
  }
  if (!result.stdout.includes('Mach-O') || !result.stdout.includes('arm64')) {
    fail(`Unexpected native extension format for ${extensionPath}: ${result.stdout.trim()}`);
  }
}

console.log(`Found ${nativeExtensions.length} pydantic_core native extension(s).`);
