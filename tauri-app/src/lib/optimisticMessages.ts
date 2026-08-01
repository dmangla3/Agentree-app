import type { Message, AttachmentMetadata } from '../stores/workspaceStore';
import type { AgentRunProjectedMessage } from '../stores/agentRunProjectionStore';

export interface OptimisticMessageConfig {
  workspaceId: string;
  parentId: string | null;
  content: string;
  attachments: AttachmentMetadata[];
  scopeId: string | null;
  pathIds: string[];
  depth: number;
  role: 'user' | 'assistant';
  status?: string | null;
  agentId?: string | null;
  llmModel?: string | null;
  llmProvider?: string | null;
}

export interface OptimisticNodePair {
  userMessage: AgentRunProjectedMessage;
  assistantMessage: AgentRunProjectedMessage | null;
  userMessageId: string;
  assistantMessageId: string | null;
}

/**
 * Generate a deterministic optimistic ID based on content and timestamp
 * This helps with debugging and prevents duplicate optimistic nodes
 */
export function generateOptimisticId(prefix: 'opt-user' | 'opt-assistant'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Create an optimistic user message
 */
export function createOptimisticUserMessage(
  config: OptimisticMessageConfig
): AgentRunProjectedMessage {
  const now = new Date().toISOString();
  const id = generateOptimisticId('opt-user');

  return {
    id,
    role: config.role,
    content: config.content,
    parentId: config.parentId,
    workspaceId: config.workspaceId,
    attachments: config.attachments.length > 0 ? config.attachments : null,
    scope_id: config.scopeId,
    path_ids: config.pathIds,
    depth: config.depth,
    createdAt: now,
    updatedAt: now,
    // Optimistic-specific fields
    _optimistic: true,
    _optimisticStatus: 'pending',
    _optimisticError: null,
    _setupProgress: 'Sending...',
    _rollbackOnFail: true,
    // Default values for required fields
    llmProvider: null,
    llmModel: null,
    annotations: null,
    tags: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    processedContent: null,
    reasoning: null,
    followupQuestions: null,
    aiLabel: null,
    parentSummaryId: null,
    citations: null,
    comments: null,
    agent_id: config.agentId || null,
    status: (config.status as any) || null,
    node_delta: null,
    execution_data: null,
    last_event_at: null,
    collapsed: false,
    context_active: true,
    output_commit_sha: null,
    git_branch_name: null,
    branchPointers: null,
  };
}

/**
 * Create an optimistic assistant message
 */
export function createOptimisticAssistantMessage(
  config: OptimisticMessageConfig,
  parentUserMessageId: string
): AgentRunProjectedMessage {
  const now = new Date().toISOString();
  const id = generateOptimisticId('opt-assistant');

  return {
    id,
    role: 'assistant',
    content: '',
    parentId: parentUserMessageId,
    workspaceId: config.workspaceId,
    attachments: null,
    scope_id: config.scopeId,
    path_ids: [...config.pathIds, id],
    depth: config.depth + 1,
    llmModel: config.llmModel || null,
    llmProvider: config.llmProvider || null,
    agent_id: config.agentId || null,
    status: config.agentId ? 'pending' : null,
    createdAt: now,
    updatedAt: now,
    // Optimistic-specific fields
    _optimistic: true,
    _optimisticStatus: config.agentId ? 'pending' : 'running',
    _optimisticError: null,
    _setupProgress: config.agentId ? 'Creating node...' : 'Waiting for response...',
    _rollbackOnFail: true,
    // Default values
    annotations: null,
    tags: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    processedContent: null,
    reasoning: null,
    followupQuestions: null,
    aiLabel: null,
    parentSummaryId: null,
    citations: null,
    comments: null,
    node_delta: null,
    execution_data: config.agentId ? { timeline: [] } : null,
    last_event_at: null,
    collapsed: false,
    context_active: true,
    output_commit_sha: null,
    git_branch_name: null,
    branchPointers: null,
  };
}

/**
 * Create both user and assistant optimistic messages
 */
export function createOptimisticNodePair(
  userConfig: OptimisticMessageConfig,
  assistantConfig?: Partial<OptimisticMessageConfig>
): OptimisticNodePair {
  const userMessage = createOptimisticUserMessage(userConfig);
  
  // Update pathIds to include user message
  const userPathIds = [...userConfig.pathIds, userMessage.id];
  userMessage.path_ids = userPathIds;

  // Create assistant message if this is a user message with expected response
  let assistantMessage: AgentRunProjectedMessage | null = null;
  if (userConfig.role === 'user') {
    assistantMessage = createOptimisticAssistantMessage(
      {
        ...userConfig,
        ...assistantConfig,
        pathIds: userPathIds,
        depth: userConfig.depth,
      },
      userMessage.id
    );
  }

  return {
    userMessage,
    assistantMessage,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage?.id || null,
  };
}

/**
 * Check if a message ID is an optimistic ID
 */
export function isOptimisticId(id: string): boolean {
  return id.startsWith('opt-');
}

/**
 * Extract the original optimistic ID from a potentially replaced message
 */
export function getOptimisticIdFromMessage(message: Message): string | null {
  if (isOptimisticId(message.id)) {
    return message.id;
  }
  // Check if this was a replacement (would need to track this elsewhere)
  return null;
}

/**
 * Calculate path IDs for a new message based on parent
 */
export function calculatePathIds(
  parentPathIds: string[] | null | undefined,
  newMessageId: string
): string[] {
  if (!parentPathIds || parentPathIds.length === 0) {
    return [newMessageId];
  }
  return [...parentPathIds, newMessageId];
}

/**
 * Error types for optimistic message failures
 */
export enum OptimisticErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  CONFLICT_ERROR = 'CONFLICT_ERROR', // 409 - parent still running
  SERVER_ERROR = 'SERVER_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  CANCELLED = 'CANCELLED',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export interface OptimisticError {
  type: OptimisticErrorType;
  message: string;
  originalError?: unknown;
  recoverable: boolean;
}

/**
 * Categorize an error from the API
 */
export function categorizeError(error: unknown): OptimisticError {
  // Check for axios error
  const axiosError = error as any;
  
  // Cancelled
  if (axiosError?.name === 'CanceledError' || axiosError?.__CANCEL__) {
    return {
      type: OptimisticErrorType.CANCELLED,
      message: 'Request was cancelled',
      originalError: error,
      recoverable: true,
    };
  }

  // Network errors
  if (!axiosError?.response) {
    return {
      type: OptimisticErrorType.NETWORK_ERROR,
      message: 'Network error. Please check your connection and try again.',
      originalError: error,
      recoverable: true,
    };
  }

  const status = axiosError.response?.status;
  const message = axiosError.response?.data?.message || axiosError.message || 'An error occurred';

  // Conflict - parent still running
  if (status === 409) {
    return {
      type: OptimisticErrorType.CONFLICT_ERROR,
      message: message || 'Parent message is still processing. Please wait and try again.',
      originalError: error,
      recoverable: true,
    };
  }

  // Validation errors
  if (status === 400 || status === 422) {
    return {
      type: OptimisticErrorType.VALIDATION_ERROR,
      message: message || 'Invalid request. Please check your input and try again.',
      originalError: error,
      recoverable: false,
    };
  }

  // Server errors
  if (status >= 500) {
    return {
      type: OptimisticErrorType.SERVER_ERROR,
      message: 'Server error. Please try again later.',
      originalError: error,
      recoverable: true,
    };
  }

  // Timeout
  if (status === 408 || message?.toLowerCase().includes('timeout')) {
    return {
      type: OptimisticErrorType.TIMEOUT_ERROR,
      message: 'Request timed out. Please try again.',
      originalError: error,
      recoverable: true,
    };
  }

  // Default
  return {
    type: OptimisticErrorType.UNKNOWN_ERROR,
    message: message || 'An unexpected error occurred',
    originalError: error,
    recoverable: false,
  };
}

/**
 * Format error message for display
 */
export function formatErrorMessage(error: OptimisticError): string {
  if (error.type === OptimisticErrorType.CONFLICT_ERROR) {
    return error.message;
  }
  if (error.type === OptimisticErrorType.NETWORK_ERROR) {
    return 'Connection failed. Your message was not sent.';
  }
  if (error.type === OptimisticErrorType.VALIDATION_ERROR) {
    return error.message;
  }
  return error.message;
}

/**
 * Determine if we should retry a failed operation
 */
export function shouldRetry(error: OptimisticError, attemptCount: number): boolean {
  const maxRetries = 2;
  if (attemptCount >= maxRetries) return false;
  if (!error.recoverable) return false;
  if (error.type === OptimisticErrorType.CONFLICT_ERROR) return false; // Don't auto-retry conflicts
  return true;
}
