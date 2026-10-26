import {
  applyComposerPermissionArgs,
  DEFAULT_COMPOSER_PERMISSION_MODE,
  type ComposerPermissionMode,
} from './composerPermissions';

export interface BuildAgentRuntimeArgsInput {
  agentType: string | null | undefined;
  cliArgs?: string | null;
  promptFlag?: string | null;
  prompt: string;
  permissionMode?: ComposerPermissionMode;
  providerInternalArgs?: string[];
  createClaudeSessionId?: () => string;
}

export interface BuildAgentRuntimeArgsResult {
  args: string[];
  parsedModel: string | null;
  claudeSessionId: string | null;
}

export const splitRuntimeCliArgs = (value: string | null | undefined): string[] => (
  String(value || '').split(/\s+/).filter(Boolean)
);

export const parseRuntimeCliArgs = (cliArgs: string | null | undefined): {
  model: string | null;
  permissionMode: string | null;
  reasoningEffort: string | null;
} => {
  const tokens = splitRuntimeCliArgs(cliArgs);
  let model: string | null = null;
  let permissionMode: string | null = null;
  let reasoningEffort: string | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token === '--model' && next) {
      model = next;
      index += 1;
    } else if (token === '--permission-mode' && next) {
      permissionMode = next;
      index += 1;
    } else if ((token === '--reasoning-effort' || token === '--effort' || token === '--variant') && next) {
      reasoningEffort = next;
      index += 1;
    }
  }
  return { model, permissionMode, reasoningEffort };
};

const stripClaudeCliOnlyStreamingArgs = (args: string[]): string[] => {
  const cleaned: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--output-format') {
      index += 1;
      continue;
    }
    if (arg === '-p' || arg === '--print' || arg === '--verbose' || arg === '--no-session-persistence') {
      continue;
    }
    cleaned.push(arg);
  }
  return cleaned;
};

const readArgValue = (args: string[], flag: string): string | null => {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
};

export function buildAgentRuntimeArgs(input: BuildAgentRuntimeArgsInput): BuildAgentRuntimeArgsResult {
  const originalArgs = splitRuntimeCliArgs(input.cliArgs);
  const parsed = parseRuntimeCliArgs(input.cliArgs);
  let args = input.agentType === 'claude'
    ? stripClaudeCliOnlyStreamingArgs(originalArgs)
    : originalArgs;
  let claudeSessionId: string | null = null;

  if (input.agentType === 'claude') {
    claudeSessionId = readArgValue(args, '--session-id') ?? input.createClaudeSessionId?.() ?? null;
    if (claudeSessionId && !args.includes('--session-id')) {
      args = [...args, '--session-id', claudeSessionId];
    }
  }

  const argsWithPermissions = applyComposerPermissionArgs(
    args,
    input.agentType,
    input.permissionMode ?? DEFAULT_COMPOSER_PERMISSION_MODE,
  );
  const providerInternalArgs = input.providerInternalArgs ?? [];
  const promptFlag = input.agentType === 'codex' || input.agentType === 'opencode' ? null : input.promptFlag;
  const finalArgs = promptFlag
    ? [...argsWithPermissions, ...providerInternalArgs, promptFlag, input.prompt]
    : [...argsWithPermissions, ...providerInternalArgs, input.prompt];

  return {
    args: finalArgs,
    parsedModel: parsed.model,
    claudeSessionId,
  };
}
