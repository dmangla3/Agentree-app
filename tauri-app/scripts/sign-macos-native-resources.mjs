import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.log('Skipping macOS native resource signing on non-macOS host.');
  process.exit(0);
}

const resourceDir = process.argv[2] ?? path.join('src-tauri', 'python-sdk');
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY;

if (!fs.existsSync(resourceDir)) {
  console.log(`No native resource directory found at ${resourceDir}; skipping.`);
  process.exit(0);
}

if (!signingIdentity) {
  console.error('APPLE_SIGNING_IDENTITY is required to sign macOS native resources.');
  process.exit(1);
}

const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
  encoding: 'utf8',
});

if (!identities.includes(signingIdentity)) {
  console.error(`Signing identity not found in keychain: ${signingIdentity}`);
  process.exit(1);
}

const nativeExtensions = new Set(['.dylib', '.so']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

function isMachO(filePath) {
  if (!nativeExtensions.has(path.extname(filePath)) && !filePath.includes('.framework/')) {
    return false;
  }

  const result = spawnSync('file', [filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Unable to inspect ${filePath}: ${result.stderr || result.stdout}`);
  }

  return result.stdout.includes('Mach-O');
}

let signedCount = 0;

for (const filePath of walk(resourceDir)) {
  if (!isMachO(filePath)) {
    continue;
  }

  console.log(`Signing native resource: ${filePath}`);
  execFileSync(
    'codesign',
    ['--force', '--options', 'runtime', '--timestamp', '--sign', signingIdentity, filePath],
    { stdio: 'inherit' },
  );
  signedCount += 1;
}

console.log(`Signed ${signedCount} macOS native resource(s).`);
