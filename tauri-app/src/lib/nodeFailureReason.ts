export function cleanNodeFailureReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isNodeFailureStatus(status: unknown): boolean {
  return status === 'failed' || status === 'error' || status === 'failed_setup' || status === 'failed_spawn';
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
