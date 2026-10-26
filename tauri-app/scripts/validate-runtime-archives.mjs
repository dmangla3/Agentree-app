#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const manifestPath = path.resolve(
  argumentValue("--manifest", path.join(projectRoot, "runtime-manifest.json")),
);
const archivesDir = path.resolve(
  argumentValue(
    "--archives-dir",
    path.join(projectRoot, "src-tauri", "target", "runtime-archives"),
  ),
);
const platformArgument = argumentValue("--platform", "");
const componentArgument = argumentValue("--component", "");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const platforms = platformArgument
  ? platformArgument.split(",").map((value) => value.trim())
  : ["linux-x86_64", "darwin-aarch64"];
const components = componentArgument
  ? new Set(componentArgument.split(",").map((value) => value.trim()))
  : null;
if (components) {
  for (const component of components) {
    if (!manifest.components[component])
      fail(`Unknown runtime component: ${component}`);
  }
}

const PLATFORM_CONTRACTS = {
  "darwin-aarch64": {
    claudePackage: "claude-agent-sdk-darwin-arm64",
    binaryFormat: "Mach-O arm64",
  },
  "linux-x86_64": {
    claudePackage: "claude-agent-sdk-linux-x64",
    binaryFormat: "ELF x86-64",
  },
};

function fail(message) {
  throw new Error(message);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function assertBinaryFormat(filePath, expectedFormat) {
  const header = Buffer.alloc(20);
  const file = fs.openSync(filePath, "r");
  try {
    if (fs.readSync(file, header, 0, header.length, 0) < header.length) {
      fail(`${filePath} is too short to be a native executable`);
    }
  } finally {
    fs.closeSync(file);
  }

  if (expectedFormat === "Mach-O arm64") {
    if (
      header.readUInt32LE(0) !== 0xfeedfacf ||
      header.readUInt32LE(4) !== 0x0100000c
    ) {
      fail(`${filePath} is not a 64-bit arm64 Mach-O executable`);
    }
    return;
  }

  if (
    header.subarray(0, 4).toString("hex") !== "7f454c46" ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header.readUInt16LE(18) !== 62
  ) {
    fail(`${filePath} is not a 64-bit x86-64 ELF executable`);
  }
}

function validateArchive(component, spec, platform) {
  const contract = PLATFORM_CONTRACTS[platform];
  if (!contract) fail(`Unsupported runtime platform: ${platform}`);
  const platformSpec = spec.platforms?.[platform];
  if (!platformSpec)
    fail(`Missing ${component} manifest entry for ${platform}`);

  const archiveName = `agentree-runtime-${component}-${spec.version}-${platform}.tar.gz`;
  const archivePath = path.join(archivesDir, archiveName);
  if (!fs.existsSync(archivePath))
    fail(`Missing runtime archive: ${archivePath}`);

  const actualChecksum = sha256(archivePath);
  if (actualChecksum !== platformSpec.sha256) {
    fail(
      `${archiveName} checksum ${actualChecksum} does not match manifest ${platformSpec.sha256}`,
    );
  }

  const members = run("tar", ["-tzf", archivePath]).split("\n").filter(Boolean);
  if (
    members.some(
      (member) => member.startsWith("/") || member.split("/").includes(".."),
    )
  ) {
    fail(`${archiveName} contains an unsafe archive path`);
  }

  const requiredMembers = {
    node: ["./bin/node"],
    codex: ["./bin/codex"],
    opencode: [
      "./bin/opencode",
      "./bin/rg",
      "./node_modules/@opencode-ai/sdk/package.json",
      "./node_modules/@opencode-ai/sdk/dist/index.js",
    ],
    "claude-sdk": [
      "./node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      `./node_modules/@anthropic-ai/${contract.claudePackage}/claude`,
    ],
  }[component];
  if (!requiredMembers) fail(`Unsupported runtime component: ${component}`);
  for (const member of requiredMembers) {
    if (!members.includes(member)) fail(`${archiveName} is missing ${member}`);
  }

  const binaryMembers =
    component === "claude-sdk"
      ? [requiredMembers[1]]
      : component === "opencode"
        ? requiredMembers.slice(0, 2)
        : [requiredMembers[0]];
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentree-runtime-validate-"),
  );
  try {
    for (const binaryMember of binaryMembers) {
      run("tar", ["-xzf", archivePath, "-C", tempDir, binaryMember]);
      const binaryPath = path.join(tempDir, binaryMember.replace(/^\.\//, ""));
      const stat = fs.statSync(binaryPath);
      if (!stat.isFile())
        fail(`${archiveName} ${binaryMember} is not a regular file`);
      if ((stat.mode & 0o111) === 0)
        fail(`${archiveName} ${binaryMember} is not executable`);
      assertBinaryFormat(binaryPath, contract.binaryFormat);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`Validated ${archiveName}`);
}

for (const platform of platforms) {
  for (const [component, spec] of Object.entries(manifest.components)) {
    if (components && !components.has(component)) continue;
    validateArchive(component, spec, platform);
  }
}

console.log("Runtime archive validation passed");
