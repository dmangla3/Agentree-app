import fs from 'node:fs';
import path from 'node:path';

const version = process.argv[2]?.trim();

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/sync-version.mjs <semver>');
  process.exit(1);
}

const projectRoot = process.cwd();

const updateJsonVersion = (relativePath) => {
  const filePath = path.join(projectRoot, relativePath);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  json.version = version;
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`Updated ${relativePath} -> ${version}`);
};

updateJsonVersion('package.json');
updateJsonVersion(path.join('src-tauri', 'tauri.conf.json'));
updateJsonVersion(path.join('src-tauri', 'tauri.dev.conf.json'));

const cargoTomlPath = path.join(projectRoot, 'src-tauri', 'Cargo.toml');
const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
const updatedCargoToml = cargoToml.replace(
  /^version = ".*"$/m,
  `version = "${version}"`
);

if (cargoToml === updatedCargoToml && !new RegExp(`^version = "${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm').test(cargoToml)) {
  throw new Error('Failed to update version in src-tauri/Cargo.toml');
}

fs.writeFileSync(cargoTomlPath, updatedCargoToml);
console.log(`Updated src-tauri/Cargo.toml -> ${version}`);
