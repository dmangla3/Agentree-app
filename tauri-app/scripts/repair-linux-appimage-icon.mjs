import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'linux') {
  console.log('Skipping AppImage icon repair on non-Linux platform.');
  process.exit(0);
}

const projectRoot = process.cwd();
const appimageDir = path.join(projectRoot, 'src-tauri', 'target', 'release', 'bundle', 'appimage');
const pluginPath =
  process.env.LINUXDEPLOY_PLUGIN_APPIMAGE ||
  path.join(os.homedir(), '.cache', 'tauri', 'linuxdeploy-plugin-appimage.AppImage');
const tauriBin = path.join(projectRoot, 'node_modules', '.bin', 'tauri');
const hasSigningKey =
  Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) ||
  Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim());

if (!fs.existsSync(appimageDir)) {
  console.log(`No AppImage bundle directory found at ${appimageDir}; skipping icon repair.`);
  process.exit(0);
}

if (!fs.existsSync(pluginPath)) {
  throw new Error(`Missing linuxdeploy AppImage plugin at ${pluginPath}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

function parseDesktopIcon(appDir) {
  const desktopCandidates = [
    ...fs.readdirSync(appDir)
      .filter((entry) => entry.endsWith('.desktop'))
      .map((entry) => path.join(appDir, entry)),
  ];
  const applicationsDir = path.join(appDir, 'usr', 'share', 'applications');

  if (fs.existsSync(applicationsDir)) {
    desktopCandidates.push(
      ...fs.readdirSync(applicationsDir)
        .filter((entry) => entry.endsWith('.desktop'))
        .map((entry) => path.join(applicationsDir, entry)),
    );
  }

  for (const desktopPath of desktopCandidates) {
    const source = fs.readFileSync(desktopPath, 'utf8');
    const iconLine = source
      .split(/\r?\n/)
      .find((line) => line.startsWith('Icon='));

    if (iconLine) {
      return iconLine.slice('Icon='.length).trim();
    }
  }

  return null;
}

function findIconReference(appDir) {
  const iconName = parseDesktopIcon(appDir);

  if (iconName) {
    const rootIcon = path.join(appDir, `${iconName}.png`);
    if (fs.existsSync(rootIcon)) {
      return `${iconName}.png`;
    }
  }

  const rootPng = fs.readdirSync(appDir).find((entry) => entry.endsWith('.png'));
  if (rootPng) {
    return rootPng;
  }

  throw new Error(`Could not find a root PNG icon in ${appDir}`);
}

function repairDirIcon(appDir) {
  const dirIconPath = path.join(appDir, '.DirIcon');
  const iconReference = findIconReference(appDir);

  fs.rmSync(dirIconPath, { force: true });
  fs.symlinkSync(iconReference, dirIconPath);

  const linkTarget = fs.readlinkSync(dirIconPath);
  if (path.isAbsolute(linkTarget)) {
    throw new Error(`.DirIcon still points to an absolute path: ${linkTarget}`);
  }

  fs.statSync(path.join(appDir, linkTarget));
  console.log(`Repaired ${dirIconPath} -> ${linkTarget}`);
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { force: true, recursive: true });
}

function pruneHostGraphicsRuntime(appDir) {
  const usrLib = path.join(appDir, 'usr', 'lib');
  const multiarchLib = path.join(appDir, 'usr', 'lib', 'x86_64-linux-gnu');
  const directories = [
    path.join(multiarchLib, 'webkit2gtk-4.1'),
    path.join(multiarchLib, 'gtk-3.0'),
    path.join(multiarchLib, 'gstreamer-1.0'),
    path.join(usrLib, 'gstreamer-1.0'),
  ];
  const libraryPrefixes = [
    'libwebkit2gtk-4.1',
    'libjavascriptcoregtk-4.1',
    'libgtk-3',
    'libgdk-3',
    'libgdk_pixbuf-2.0',
    'libpango',
    'libcairo',
    'libharfbuzz',
    'libepoxy',
    'libatk',
    'libatspi',
    'libsoup-3.0',
    'libgst',
    'libgstreamer',
    'liborc-',
    'libglib-2.0',
    'libgio-2.0',
    'libgobject-2.0',
    'libgmodule-2.0',
    'libgthread-2.0',
    'libffi',
    'libwayland',
    'libxkbcommon',
    'libX',
    'libxcb',
    'libfontconfig',
    'libfreetype',
    'libpcre2',
    'libmount',
    'libblkid',
    'libselinux',
    'libz',
    'liblzma',
    'libzstd',
    'libssl',
    'libcrypto',
    'libunwind',
  ];
  let removed = 0;

  for (const directory of directories) {
    if (fs.existsSync(directory)) {
      removeIfExists(directory);
      removed += 1;
    }
  }

  if (fs.existsSync(usrLib)) {
    for (const entry of fs.readdirSync(usrLib)) {
      if (libraryPrefixes.some((prefix) => entry.startsWith(prefix))) {
        removeIfExists(path.join(usrLib, entry));
        removed += 1;
      }
    }
  }

  if (removed > 0) {
    console.log(`Pruned ${removed} bundled host graphics/runtime entries from ${appDir}`);
  }
}

function findAppImageTargets(appDirName) {
  const appName = appDirName.replace(/\.AppDir$/, '');
  return fs.readdirSync(appimageDir)
    .filter((entry) => entry.endsWith('.AppImage'))
    .filter((entry) =>
      entry === `${appName}.AppImage` ||
      entry.startsWith(`${appName}_`) ||
      entry.startsWith(`${appName}-`))
    .map((entry) => path.join(appimageDir, entry));
}

function signAppImage(appImagePath) {
  const signer = fs.existsSync(tauriBin) ? tauriBin : 'tauri';
  run(signer, ['signer', 'sign', appImagePath], { cwd: projectRoot });
}

const appDirs = fs.readdirSync(appimageDir)
  .filter((entry) => entry.endsWith('.AppDir'))
  .map((entry) => path.join(appimageDir, entry));

if (appDirs.length === 0) {
  console.log('No AppDir found; skipping AppImage icon repair.');
  process.exit(0);
}

for (const appDir of appDirs) {
  pruneHostGraphicsRuntime(appDir);
  repairDirIcon(appDir);

  const targets = findAppImageTargets(path.basename(appDir));
  if (targets.length === 0) {
    throw new Error(`No AppImage output found for ${appDir}`);
  }

  for (const target of targets) {
    const signaturePath = `${target}.sig`;
    const hadSignature = fs.existsSync(signaturePath);

    fs.rmSync(target, { force: true });
    fs.rmSync(signaturePath, { force: true });

    run(pluginPath, [`--appdir=${appDir}`], {
      cwd: appimageDir,
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: process.env.APPIMAGE_EXTRACT_AND_RUN || '1',
        LDAI_OUTPUT: target,
      },
    });

    if (hadSignature || hasSigningKey) {
      if (hasSigningKey) {
        signAppImage(target);
      } else {
        console.log(`Removed stale AppImage signature for unsigned build: ${signaturePath}`);
      }
    }
  }
}
