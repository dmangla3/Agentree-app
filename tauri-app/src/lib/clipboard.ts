import { writeText as writeTauriClipboardText } from '@tauri-apps/plugin-clipboard-manager';

export async function writeClipboardText(text: string): Promise<void> {
  let tauriError: unknown = null;

  try {
    await writeTauriClipboardText(text);
    return;
  } catch (error) {
    tauriError = error;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      throw new Error(`Clipboard write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Clipboard write failed: ${tauriError instanceof Error ? tauriError.message : String(tauriError)}`);
}
