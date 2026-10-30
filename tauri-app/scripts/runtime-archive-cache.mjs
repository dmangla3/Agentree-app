import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NORMALIZED_ARCHIVE_TIME = new Date('2000-01-01T00:00:00.000Z');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function archiveEntries(sourceDir) {
  const entries = [];
  const visit = (relativeDir) => {
    const absoluteDir = path.join(sourceDir, relativeDir);
    const children = fs
      .readdirSync(absoluteDir, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      const relativePath = path.join(relativeDir, child.name);
      const archivePath = `./${relativePath.split(path.sep).join('/')}`;
      entries.push(archivePath);
      if (child.isDirectory()) visit(relativePath);
    }
  };
  visit('');
  return entries;
}

function normalizeArchiveTimes(sourceDir, entries) {
  for (const entry of [...entries].reverse()) {
    const relativePath = entry.replace(/^\.\//, '').split('/').join(path.sep);
    const absolutePath = path.join(sourceDir, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() && fs.lutimesSync) {
      fs.lutimesSync(absolutePath, NORMALIZED_ARCHIVE_TIME, NORMALIZED_ARCHIVE_TIME);
    } else if (!stat.isSymbolicLink()) {
      fs.utimesSync(absolutePath, NORMALIZED_ARCHIVE_TIME, NORMALIZED_ARCHIVE_TIME);
    }
  }
}

export function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function runtimeBuildKey(input) {
  return crypto.createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export function archiveFileName(component, version, platform) {
  return `agentree-runtime-${component}-${version}-${platform}.tar.gz`;
}

export function archiveUrl(releaseBase, fileName, checksum) {
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error(`Invalid runtime archive SHA-256: ${checksum}`);
  }
  return `${releaseBase.replace(/\/$/, '')}/sha256/${checksum}/${fileName}`;
}

export function archiveFileNameFromUrl(url) {
  const fileName = path.posix.basename(new URL(url).pathname);
  if (!/^agentree-runtime-.+-[^/]+\.tar\.gz$/.test(fileName)) {
    throw new Error(`Invalid runtime archive URL: ${url}`);
  }
  return fileName;
}

// The runtime builders only pass disposable staging directories. Normalizing
// their metadata, archive order, ownership, and gzip header makes the output
// byte-for-byte reproducible without changing executable modes or symlinks.
export function packDirectoryDeterministically(sourceDir, destinationFile) {
  const entries = archiveEntries(sourceDir);
  if (entries.length === 0) throw new Error(`Cannot archive empty directory: ${sourceDir}`);
  normalizeArchiveTimes(sourceDir, entries);

  fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
  const temporaryBase = `${destinationFile}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const temporaryTar = `${temporaryBase}.tar`;
  const temporaryGzip = `${temporaryTar}.gz`;
  const listFile = `${temporaryBase}.list`;
  fs.writeFileSync(listFile, `${entries.join('\0')}\0`);

  try {
    const tarVersion = run('tar', ['--version']);
    const commonArgs = ['--no-recursion', '--null', '-cf', temporaryTar, '-C', sourceDir, '-T', listFile];
    if (tarVersion.toLowerCase().includes('bsdtar')) {
      run('tar', [
        '--no-xattrs',
        '--format',
        'ustar',
        '--uid',
        '0',
        '--gid',
        '0',
        '--uname',
        'root',
        '--gname',
        'root',
        ...commonArgs,
      ]);
    } else {
      run('tar', [
        '--format=ustar',
        '--sort=name',
        '--mtime=@946684800',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        ...commonArgs,
      ]);
    }
    run('gzip', ['-n', '-9', '-f', temporaryTar]);
    fs.renameSync(temporaryGzip, destinationFile);
  } finally {
    fs.rmSync(temporaryTar, { force: true });
    fs.rmSync(temporaryGzip, { force: true });
    fs.rmSync(listFile, { force: true });
  }
}
