import fs from 'node:fs';
import path from 'node:path';

const sdkDir = path.join('src-tauri', 'python-sdk');

if (!fs.existsSync(sdkDir)) {
  console.log(`No Python SDK directory found at ${sdkDir}; skipping cleanup.`);
  process.exit(0);
}

let removedFiles = 0;
let removedDirs = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') {
        fs.rmSync(entryPath, { recursive: true, force: true });
        removedDirs += 1;
        continue;
      }
      walk(entryPath);
    } else if (entry.isFile() && (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo'))) {
      fs.rmSync(entryPath, { force: true });
      removedFiles += 1;
    }
  }
}

walk(sdkDir);
console.log(`Removed ${removedFiles} Python bytecode file(s) and ${removedDirs} __pycache__ directories.`);
