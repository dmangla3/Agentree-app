import { isTerminalAgentStatus } from '@shared/agentStatus';
import type { Message } from '../../stores/workspaceStore';
import {
  getMessageBaseCommitSha,
  getMessageBaseSelectedFromNodeId,
  getMessageOutputCommitSha,
} from './commitAccessors';

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const cleanTerminalStatus = (value: unknown): string | null => {
  const status = cleanString(value);
  return isTerminalAgentStatus(status) ? status : null;
};

const terminalStatus = (message: Message): string | null => (
  cleanTerminalStatus(message.execution_data?.last_terminal_status)
    ?? cleanTerminalStatus(message.status)
);

const syntheticCommitLabel = (message: Message): string | null => {
  if (!getMessageOutputCommitSha(message)) return null;
  return cleanString(message.commit?.subject)
    ?? cleanString(message.execution_data?.meta?.commit_message)
    ?? cleanString(message.aiLabel);
};

const structuralFingerprint = (message: Message) => JSON.stringify({
  id: message.id,
  role: message.role,
  parentId: message.parentId ?? null,
  terminalStatus: terminalStatus(message),
  outputCommitSha: getMessageOutputCommitSha(message),
  baseCommitSha: getMessageBaseCommitSha(message),
  baseSelectedFromNodeId: getMessageBaseSelectedFromNodeId(message),
  gitBranchName: cleanString(message.git_branch_name),
  commitSha: cleanString(message.commit?.sha),
  commitFirstParentSha: cleanString(message.commit?.first_parent_sha),
  syntheticCommitLabel: syntheticCommitLabel(message),
});

export const shouldRefreshHeldGraphMessagesForStructuralChange = (
  current: Message[] | null | undefined,
  incoming: Message[] | null | undefined,
): boolean => {
  if (!current || !incoming) return true;
  if (current.length !== incoming.length) return true;

  for (let index = 0; index < incoming.length; index += 1) {
    if (structuralFingerprint(current[index]) !== structuralFingerprint(incoming[index])) {
      return true;
    }
  }

  return false;
};
