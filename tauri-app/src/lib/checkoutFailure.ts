import { getErrorMessage } from './api';

type CheckoutFailureMode = 'manual' | 'auto';

export interface CheckoutFailureToast {
  title: string;
  description: string;
  variant: 'warning' | 'error';
}

const UNKNOWN_ERROR_MESSAGE = 'An unknown error occurred';

export function describeCheckoutFailure(
  error: unknown,
  mode: CheckoutFailureMode,
): CheckoutFailureToast {
  const extractedMessage = getErrorMessage(error).trim();
  const description = extractedMessage && extractedMessage !== UNKNOWN_ERROR_MESSAGE
    ? extractedMessage
    : 'Git did not provide a reason for the checkout failure.';
  const hasUncommittedChanges = description.toLowerCase().includes('uncommitted changes');
  const titlePrefix = mode === 'auto' ? 'Auto Checkout' : 'Checkout';

  return {
    title: `${titlePrefix} ${hasUncommittedChanges ? 'Skipped' : 'Failed'}`,
    description,
    variant: hasUncommittedChanges ? 'warning' : 'error',
  };
}
