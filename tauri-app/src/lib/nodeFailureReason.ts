import { isFailureAgentStatus } from '@shared/agentStatus';

function cleanNodeFailureReasonAtDepth(value: unknown, depth: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (depth >= 4 || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    const nestedMessage = parsed?.error?.message
      ?? parsed?.message
      ?? (typeof parsed?.error === 'string' ? parsed.error : null);
    return cleanNodeFailureReasonAtDepth(nestedMessage, depth + 1) ?? trimmed;
  } catch {
    return trimmed;
  }
}

export function cleanNodeFailureReason(value: unknown): string | null {
  return cleanNodeFailureReasonAtDepth(value, 0);
}

export function isNodeFailureStatus(status: unknown): boolean {
  return isFailureAgentStatus(status);
}

export function getNodeFailureReason(
  executionData: any,
  fallbackMessage?: unknown,
): string | null {
  return cleanNodeFailureReason(executionData?.failure_reason)
    ?? cleanNodeFailureReason(executionData?.setup_error)
    ?? cleanNodeFailureReason(executionData?.stop_reason)
    ?? cleanNodeFailureReason(executionData?.meta?.provider_error_message)
    ?? cleanNodeFailureReason(fallbackMessage);
}
