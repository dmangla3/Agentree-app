const splitRuntimeCliArgs = (value: string | null | undefined): string[] => (
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
