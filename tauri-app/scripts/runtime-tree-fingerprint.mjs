import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function runtimeTreeSha256(projectRoot, component, archivePath) {
  const result = spawnSync(
    'cargo',
    [
      'run',
      '--quiet',
      '--manifest-path',
      path.join(projectRoot, 'src-tauri', 'Cargo.toml'),
      '--example',
      'runtime-fingerprint',
      '--',
      component,
      path.resolve(archivePath),
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Rust runtime fingerprint failed for ${component}:\n${result.stderr || result.stdout}`,
    );
  }
  const fingerprint = result.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error(`Rust runtime fingerprint returned invalid output: ${fingerprint}`);
  }
  return fingerprint;
}
