import type {
  BuildWorkspaceProjectionInput,
} from './workspaceProjection';
import type {
  CommitEntity,
  CommitObservationEntity,
  CommitParentEntity,
  Message,
  Summary,
} from '../stores/workspaceStore';

type PublicGraphRole = 'user' | 'assistant' | string;

type PublicWorkLogEntry = {
  id?: string | null;
  type: string;
  label: string;
  status?: string | null;
  timestamp?: string | null;
  durationMs?: number | null;
};

type PublicCommitFileChange = {
  additions: number | null;
  deletions: number | null;
  status: string | null;
};

type PublicCommitRow = {
  sha: string;
  subject: string;
  author_name: string | null;
  authored_at: string | null;
  parents: string[];
  files_changed_count: number | null;
  total_additions: number | null;
  total_deletions: number | null;
  files_changed: PublicCommitFileChange[];
};

type PublicCommitMeta = {
  sync_source: string | null;
  imported_from_ref: string | null;
  source_ref: string | null;
  git_author_name: string | null;
  git_authored_at: string | null;
  files_changed_count: number | null;
  total_additions: number | null;
  total_deletions: number | null;
  files_changed: PublicCommitFileChange[];
  commits: PublicCommitRow[];
};

type PublicGraphMessage = {
  id: string;
  role: PublicGraphRole;
  parentId: string | null;
  workspaceId: string;
  tags?: string[] | null;
  createdAt: string;
  updatedAt: string;
  aiLabel?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  content?: string;
  contentPreview?: string;
  path_ids?: string[] | null;
  depth?: number | null;
  agent_id?: string | null;
  status?: string | null;
  base_commit_sha?: string | null;
  output_commit_sha?: string | null;
  base_selected_from_node_id?: string | null;
  commit?: PublicCommitMeta | null;
  collapsed?: boolean | null;
  context_active?: boolean | null;
  execution?: {
    startedAt?: string | null;
    endedAt?: string | null;
    usage?: {
      input_tokens?: number | null;
      output_tokens?: number | null;
      total_tokens?: number | null;
      cached_input_tokens?: number | null;
    } | null;
    cacheUsage?: {
      input_tokens?: number | null;
      output_tokens?: number | null;
      total_tokens?: number | null;
      cached_input_tokens?: number | null;
    } | null;
    workLogs?: PublicWorkLogEntry[];
  } | null;
};

export type PublicShareProjectionPayload = {
  workspace: {
    id: string;
  };
  graph: {
    rootNodeId: string;
    messages: PublicGraphMessage[];
  };
};

const toMessageRole = (role: PublicGraphRole): Message['role'] => (
  role === 'user' ? 'user' : 'assistant'
);

const publicCommitMetaForExecution = (meta: PublicCommitMeta | null | undefined) => {
  if (!meta) return undefined;
  return {
    sync_source: meta.sync_source,
    imported_from_ref: meta.imported_from_ref,
    source_ref: meta.source_ref,
    git_author_name: meta.git_author_name,
    git_authored_at: meta.git_authored_at,
    files_changed_count: meta.files_changed_count,
    total_additions: meta.total_additions,
    total_deletions: meta.total_deletions,
    files_changed: meta.files_changed,
    commit_count: meta.commits.length || null,
  };
};

const publicWorkLogsToTimeline = (workLogs: PublicWorkLogEntry[] | null | undefined) => {
  if (!Array.isArray(workLogs) || workLogs.length === 0) return undefined;
  return workLogs.map((row, index) => {
    const type = row.type?.trim() || 'tool_use';
    const label = row.label?.trim() || type.replace(/_/g, ' ');
    const status = row.status?.trim() || null;
    return {
      id: row.id?.trim() || `public-work-log-${index}`,
      type: type === 'thinking' || type === 'message' || type === 'error' ? type : 'tool_use',
      toolName: label,
      content: label,
      timestamp: row.timestamp ?? undefined,
      durationMs: row.durationMs ?? undefined,
      toolOutput: status === 'completed' ? '' : undefined,
      isError: status === 'failed' || status === 'error',
    };
  });
};

const modelFromAgentId = (agentId: string | null | undefined): { provider: string | null; model: string | null } => {
  const raw = agentId?.trim();
  if (!raw) return { provider: null, model: null };
  const parts = raw.split(':').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { provider: null, model: raw };
  const provider = parts[0] || null;
  const model = parts.length >= 3
    ? `${provider}/${parts[1]}-${parts.slice(2).join('-')}`
    : `${provider}/${parts[1]}`;
  return { provider, model };
};

const buildPublicExecutionData = (message: PublicGraphMessage) => ({
  started_at: message.execution?.startedAt ?? null,
  ended_at: message.execution?.endedAt ?? null,
  usage: message.execution?.usage ?? undefined,
  cache_usage: message.execution?.cacheUsage ?? undefined,
  work_logs: message.execution?.workLogs ?? undefined,
  timeline: publicWorkLogsToTimeline(message.execution?.workLogs),
  meta: publicCommitMetaForExecution(message.commit),
  files_changed: message.commit?.files_changed ?? undefined,
});

const publicMessageToWorkspaceMessage = (message: PublicGraphMessage): Message => {
  const agentModel = modelFromAgentId(message.agent_id);
  const usage = message.execution?.usage ?? null;
  return {
    id: message.id,
    role: toMessageRole(message.role),
    content: message.content ?? message.contentPreview ?? '',
    parentId: message.parentId,
    workspaceId: message.workspaceId,
    tags: message.tags ?? [],
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    aiLabel: message.aiLabel ?? null,
    llmProvider: message.llmProvider ?? agentModel.provider,
    llmModel: message.llmModel ?? agentModel.model,
    promptTokens: message.promptTokens ?? usage?.input_tokens ?? null,
    completionTokens: message.completionTokens ?? usage?.output_tokens ?? null,
    totalTokens: message.totalTokens ?? usage?.total_tokens ?? null,
    agent_id: message.agent_id ?? null,
    status: message.status as Message['status'],
    path_ids: message.path_ids ?? null,
    depth: message.depth ?? null,
    execution_data: buildPublicExecutionData(message),
    collapsed: Boolean(message.collapsed),
    context_active: message.context_active ?? null,
    base_commit_sha: message.base_commit_sha ?? null,
    output_commit_sha: message.output_commit_sha ?? null,
    base_selected_from_node_id: message.base_selected_from_node_id ?? null,
    commit: null,
  };
};

const publicCommitRowToCommit = (
  row: PublicCommitRow,
  workspaceId: string,
  producedByNodeId: string | null,
): CommitEntity => ({
  workspace_id: workspaceId,
  sha: row.sha,
  subject: row.subject,
  author_name: row.author_name,
  authored_at: row.authored_at,
  committed_at: row.authored_at,
  source_kind: producedByNodeId ? 'agent' : 'external',
  produced_by_node_id: producedByNodeId,
  first_parent_sha: row.parents[0] ?? null,
  files_changed_count: row.files_changed_count,
  total_additions: row.total_additions,
  total_deletions: row.total_deletions,
});

const addCommitRows = (
  message: PublicGraphMessage,
  commitsBySha: Map<string, CommitEntity>,
  commitParents: CommitParentEntity[],
  commitObservations: CommitObservationEntity[],
) => {
  const meta = message.commit;
  if (!meta) return;

  for (const row of meta.commits) {
    if (!commitsBySha.has(row.sha)) {
      commitsBySha.set(row.sha, publicCommitRowToCommit(row, message.workspaceId, message.id));
    }
    row.parents.forEach((parentSha, index) => {
      commitParents.push({
        workspace_id: message.workspaceId,
        child_sha: row.sha,
        parent_sha: parentSha,
        parent_index: index,
      });
    });
    if (meta.source_ref) {
      commitObservations.push({
        workspace_id: message.workspaceId,
        commit_sha: row.sha,
        git_ref: meta.source_ref,
        source_kind: meta.sync_source ?? 'unknown',
      });
    }
  }

  const outputSha = message.output_commit_sha;
  if (outputSha && !commitsBySha.has(outputSha)) {
    commitsBySha.set(outputSha, {
      workspace_id: message.workspaceId,
      sha: outputSha,
      subject: message.aiLabel ?? message.contentPreview ?? outputSha.slice(0, 8),
      author_name: meta.git_author_name,
      authored_at: meta.git_authored_at,
      committed_at: meta.git_authored_at,
      source_kind: 'agent',
      produced_by_node_id: message.id,
      files_changed_count: meta.files_changed_count,
      total_additions: meta.total_additions,
      total_deletions: meta.total_deletions,
    });
  }
};

export function publicPayloadToWorkspaceProjectionInput(
  payload: PublicShareProjectionPayload,
): BuildWorkspaceProjectionInput {
  const messages = payload.graph.messages.map(publicMessageToWorkspaceMessage);
  const summaries: Summary[] = [];
  const commitsBySha = new Map<string, CommitEntity>();
  const commitParents: CommitParentEntity[] = [];
  const commitObservations: CommitObservationEntity[] = [];

  for (const message of payload.graph.messages) {
    addCommitRows(message, commitsBySha, commitParents, commitObservations);
  }

  return {
    messages,
    summaries,
    commits: Array.from(commitsBySha.values()),
    commitParents,
    commitObservations,
    focusedMessageId: payload.graph.rootNodeId,
  };
}
