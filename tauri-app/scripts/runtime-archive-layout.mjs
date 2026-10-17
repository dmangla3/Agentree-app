import fs from 'node:fs';
import path from 'node:path';

export function claudeNativePackageName(npmOs, npmCpu) {
  const supported = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']);
  const platform = `${npmOs}-${npmCpu}`;
  if (!supported.has(platform)) {
    throw new Error(`Unsupported Claude Agent SDK runtime platform: ${platform}`);
  }
  return `@anthropic-ai/claude-agent-sdk-${platform}`;
}

export function claudeSdkNpmInstallArgs(version, npmOs, npmCpu) {
  return [
    'install',
    '--omit=dev',
    '--include=optional',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    `--os=${npmOs}`,
    `--cpu=${npmCpu}`,
    '--force',
    `@anthropic-ai/claude-agent-sdk@${version}`,
  ];
}

export function validateClaudeSdkVersionAlignment(packageJson, runtimeManifest) {
  const dependencyVersion = packageJson.dependencies?.['@anthropic-ai/claude-agent-sdk'];
  const runtimeVersion = runtimeManifest.components?.['claude-sdk']?.version;
  if (!dependencyVersion || dependencyVersion !== runtimeVersion) {
    throw new Error(
      `Claude Agent SDK version drift: package.json pins ${dependencyVersion ?? 'nothing'}, ` +
        `but runtime-manifest.json pins ${runtimeVersion ?? 'nothing'}`
    );
  }
}

// Release shells can carry npm omit/optional settings from a user-level
// .npmrc or environment. Preserve cache/proxy settings, but make the runtime
// archive's native dependency policy deterministic.
export function npmEnvironmentWithOptionalDependencies(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (
      ['npm_config_omit', 'npm_config_include', 'npm_config_optional'].includes(key.toLowerCase())
    ) {
      delete env[key];
    }
  }
  return env;
}

export function validateClaudeSdkInstall(nodeModulesDir, { version, npmOs, npmCpu }) {
  const sdkDir = path.join(nodeModulesDir, '@anthropic-ai', 'claude-agent-sdk');
  const sdkPackagePath = path.join(sdkDir, 'package.json');
  if (!fs.existsSync(path.join(sdkDir, 'sdk.mjs')) || !fs.existsSync(sdkPackagePath)) {
    throw new Error(`Claude Agent SDK ${version} is incomplete in ${nodeModulesDir}`);
  }

  const sdkPackage = JSON.parse(fs.readFileSync(sdkPackagePath, 'utf8'));
  if (sdkPackage.version !== version) {
    throw new Error(
      `Claude Agent SDK version mismatch: expected ${version}, found ${sdkPackage.version}`
    );
  }

  const nativePackage = claudeNativePackageName(npmOs, npmCpu);
  if (sdkPackage.optionalDependencies?.[nativePackage] !== version) {
    throw new Error(
      `Claude Agent SDK ${version} does not declare the expected ${nativePackage}@${version} optional dependency`
    );
  }

  const nativeDir = path.join(nodeModulesDir, ...nativePackage.split('/'));
  const nativePackagePath = path.join(nativeDir, 'package.json');
  const executablePath = path.join(nativeDir, npmOs === 'win32' ? 'claude.exe' : 'claude');
  if (
    !fs.existsSync(nativePackagePath) ||
    !fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile()
  ) {
    throw new Error(
      `Claude native executable missing for ${npmOs}-${npmCpu}: expected ${executablePath}. ` +
        'Optional dependencies must be included in the managed runtime archive.'
    );
  }
  if (npmOs !== 'win32') {
    try {
      fs.accessSync(executablePath, fs.constants.X_OK);
    } catch {
      throw new Error(`Claude native executable is not executable: ${executablePath}`);
    }
  }

  const installedNativePackage = JSON.parse(fs.readFileSync(nativePackagePath, 'utf8'));
  if (installedNativePackage.version !== version) {
    throw new Error(
      `Claude native package version mismatch: expected ${version}, found ${installedNativePackage.version}`
    );
  }
  return executablePath;
}
