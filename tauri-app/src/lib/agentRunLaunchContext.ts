import {
  buildComposerContextManifest,
  buildComposerContextSelection,
  type ComposerContextManifest,
} from './composerContext';
import { EMPTY_COMPOSER_CONTEXT_MANIFEST } from './prompts';
import type { Message } from '../stores/workspaceStore';

interface AgentRunContextManifestInput {
  contextManifest?: ComposerContextManifest | null;
  contextPolicy?: 'continue' | 'fresh';
  contextParentMessageId?: string | null;
  contextStartMessageId?: string | null;
  messages?: Message[];
}

export function buildAgentRunContextManifest(
  input: AgentRunContextManifestInput,
): ComposerContextManifest {
  if (input.contextManifest) return input.contextManifest;
  if (input.contextPolicy === 'fresh' || !input.contextParentMessageId) {
    return EMPTY_COMPOSER_CONTEXT_MANIFEST;
  }
  const messages = input.messages ?? [];
  const selection = buildComposerContextSelection(
    input.contextParentMessageId,
    messages,
    null,
    'continue',
    input.contextStartMessageId ?? null,
  );
  return buildComposerContextManifest(selection.turns, new Set(selection.defaultSelectedIds));
}
