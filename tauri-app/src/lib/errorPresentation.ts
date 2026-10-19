type JsonRecord = Record<string, unknown>;

export type ErrorPresentation = {
  title: string;
  message: string;
  isRetrying: boolean;
  retryAttempt: number | null;
  retryLimit: number | null;
  httpStatus: number | null;
  errorCode: string | null;
  technicalDetails: string | null;
};

const asRecord = (value: unknown): JsonRecord | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
);

const nonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const finiteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const parseJsonRecord = (value: unknown): JsonRecord | null => {
  const directRecord = asRecord(value);
  if (directRecord) return directRecord;

  const text = nonEmptyString(value);
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
};

const getResponseDisconnect = (record: JsonRecord | null) => {
  const codexErrorInfo = asRecord(record?.codexErrorInfo);
  return asRecord(codexErrorInfo?.responseStreamDisconnected);
};

const parseRetryProgress = (message: string | null) => {
  const match = message?.match(/\breconnecting\b.*?(\d+)\s*\/\s*(\d+)/i);
  if (!match) return { attempt: null, limit: null };
  return {
    attempt: Number(match[1]),
    limit: Number(match[2]),
  };
};

const extractErrorCode = (payload: JsonRecord, details: string | null) => {
  const direct = nonEmptyString(payload.code)
    ?? nonEmptyString(payload.errorCode)
    ?? nonEmptyString(payload.error_code)
    ?? nonEmptyString(payload.type);
  if (direct && direct !== 'error') return direct;

  return details?.match(/\b(?:auth )?error code:\s*([^,\s]+)/i)?.[1] ?? null;
};

const friendlyRetryMessage = (details: string | null, httpStatus: number | null) => {
  if (details && /\bhigh demand\b/i.test(details)) return details;
  if (httpStatus !== null && httpStatus >= 500) {
    return 'The service is temporarily unavailable. Agentree will keep trying automatically.';
  }
  return 'The connection to the agent was interrupted. Agentree will keep trying automatically.';
};

export function presentTimelineError(value: unknown): ErrorPresentation {
  const rawText = nonEmptyString(value);
  const root = parseJsonRecord(value);
  if (!root) {
    return {
      title: 'Error',
      message: rawText ?? 'An unexpected error occurred.',
      isRetrying: false,
      retryAttempt: null,
      retryLimit: null,
      httpStatus: null,
      errorCode: null,
      technicalDetails: null,
    };
  }

  const rootError = root.error;
  const payload = asRecord(rootError) ?? root;
  const nestedMessageRecord = parseJsonRecord(payload.message);
  const nestedError = asRecord(nestedMessageRecord?.error);
  const message = nonEmptyString(nestedError?.message)
    ?? nonEmptyString(nestedMessageRecord?.message)
    ?? nonEmptyString(payload.message)
    ?? (typeof rootError === 'string' ? nonEmptyString(rootError) : null)
    ?? nonEmptyString(root.message);
  const details = nonEmptyString(payload.additionalDetails)
    ?? nonEmptyString(payload.additional_details)
    ?? nonEmptyString(root.additionalDetails);
  const responseDisconnect = getResponseDisconnect(payload) ?? getResponseDisconnect(root);
  const httpStatus = finiteNumber(responseDisconnect?.httpStatusCode)
    ?? finiteNumber(payload.httpStatusCode)
    ?? finiteNumber(payload.status)
    ?? finiteNumber(nestedMessageRecord?.status);
  const retry = parseRetryProgress(message);
  const isRetrying = root.willRetry === true
    || payload.willRetry === true
    || responseDisconnect !== null
    || retry.attempt !== null;
  const errorCode = extractErrorCode(payload, details)
    ?? (nestedError ? extractErrorCode(nestedError, details) : null);

  let title = 'Request failed';
  if (isRetrying) title = 'Connection interrupted';
  else if (httpStatus === 401 || httpStatus === 403) title = 'Authentication failed';
  else if (httpStatus === 429) title = 'Rate limit reached';
  else if (httpStatus !== null && httpStatus >= 500) title = 'Service unavailable';

  const displayMessage = isRetrying
    ? friendlyRetryMessage(details, httpStatus)
    : message ?? details ?? 'An unexpected error occurred.';

  const serialized = JSON.stringify(root, null, 2);
  const technicalDetails = serialized !== JSON.stringify(displayMessage)
    ? serialized
    : null;

  return {
    title,
    message: displayMessage,
    isRetrying,
    retryAttempt: retry.attempt,
    retryLimit: retry.limit,
    httpStatus,
    errorCode,
    technicalDetails,
  };
}
