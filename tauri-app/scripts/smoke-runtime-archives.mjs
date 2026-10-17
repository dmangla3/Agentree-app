#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const resourcesDir = path.resolve(process.argv[2] || "");
const archivesDir = path.resolve(process.argv[3] || "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error(
    "Usage: smoke-runtime-archives.mjs <resources_dir> <archives_dir>",
  );
}

const platform = `${os.platform()}-${os.arch()}`;
const platformConfig = {
  "darwin-arm64": {
    key: "darwin-aarch64",
    dataRoot: [
      "Library",
      "Application Support",
      "com.agentree.agentree",
      "runtime",
    ],
    claudePackage: "claude-agent-sdk-darwin-arm64",
  },
  "linux-x64": {
    key: "linux-x86_64",
    dataRoot: [".local", "share", "com.agentree.agentree", "runtime"],
    claudePackage: "claude-agent-sdk-linux-x64",
  },
}[platform];
if (!platformConfig)
  throw new Error(`Unsupported runtime smoke platform: ${platform}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
    ...options,
  });
  if (result.error)
    throw new Error(`${command} failed: ${result.error.message}`);
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${output}`,
    );
  }
  return output;
}

function componentAndVersion(fileName) {
  const suffix = `-${platformConfig.key}.tar.gz`;
  const rest = fileName.slice("agentree-runtime-".length, -suffix.length);
  for (const component of ["claude-sdk", "node", "codex"]) {
    if (rest.startsWith(`${component}-`)) {
      return { component, version: rest.slice(component.length + 1) };
    }
  }
  throw new Error(`Unrecognized runtime archive: ${fileName}`);
}

const fakeHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "agentree-runtime-smoke-"),
);
try {
  const dataRoot = path.join(fakeHome, ...platformConfig.dataRoot);
  const archives = fs
    .readdirSync(archivesDir)
    .filter(
      (fileName) =>
        fileName.startsWith("agentree-runtime-") &&
        fileName.endsWith(`-${platformConfig.key}.tar.gz`),
    );
  if (archives.length !== 3) {
    throw new Error(
      `Expected 3 ${platformConfig.key} runtime archives, found ${archives.length}`,
    );
  }

  const installed = {};
  for (const fileName of archives) {
    const { component, version } = componentAndVersion(fileName);
    const destination = path.join(dataRoot, component, version);
    fs.mkdirSync(destination, { recursive: true });
    run("tar", ["-xzf", path.join(archivesDir, fileName), "-C", destination]);
    installed[component] = destination;
  }

  const nodeBin = path.join(installed.node, "bin", "node");
  const codexBin = path.join(installed.codex, "bin", "codex");
  const claudeBin = path.join(
    installed["claude-sdk"],
    "node_modules",
    "@anthropic-ai",
    platformConfig.claudePackage,
    "claude",
  );
  const baseEnv = {
    HOME: fakeHome,
    PATH: `${path.dirname(nodeBin)}:/usr/bin:/bin`,
  };

  const nodeVersion = run(nodeBin, ["--version"], { env: baseEnv });
  if (!/^v\d+\./.test(nodeVersion))
    throw new Error(`Unexpected Node version: ${nodeVersion}`);

  const sdkImport = run(
    nodeBin,
    [
      "--input-type=module",
      "--eval",
      "import('@anthropic-ai/claude-agent-sdk').then(() => console.log('sdk-import-ok'))",
    ],
    { cwd: installed["claude-sdk"], env: baseEnv },
  );
  if (!sdkImport.includes("sdk-import-ok"))
    throw new Error("Claude SDK import did not complete");

  const claudeVersion = run(claudeBin, ["--version"], { env: baseEnv });
  if (!claudeVersion.toLowerCase().includes("claude")) {
    throw new Error(`Unexpected Claude version output: ${claudeVersion}`);
  }

  const codexHome = path.join(fakeHome, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const codexVersion = run(codexBin, ["--version"], {
    env: { ...baseEnv, CODEX_HOME: codexHome },
  });
  if (!codexVersion.includes("codex-cli")) {
    throw new Error(`Unexpected Codex version output: ${codexVersion}`);
  }

  const bashOutput = run(
    nodeBin,
    [
      path.join(resourcesDir, "bash-adapter.cjs"),
      "-p",
      "echo runtime-smoke-ok",
    ],
    { env: baseEnv },
  );
  if (
    !bashOutput.includes('"provider_status":"completed"') ||
    !bashOutput.includes("runtime-smoke-ok")
  ) {
    throw new Error(
      "Bash adapter did not complete with the managed Node runtime",
    );
  }

  console.log(
    `Runtime smoke passed (${platformConfig.key}): ${nodeVersion}, ${claudeVersion}, ${codexVersion}`,
  );
} finally {
  fs.rmSync(fakeHome, { recursive: true, force: true });
}
