import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { commands as tauriCommands, events as tauriEvents } from '../generated/tauri-bindings';
import type {
    ActiveLoginProfileRun as NativeActiveLoginProfileRun,
    AgentLaunchContext as NativeAgentLaunchContext,
    AgentLaunchRequest_Deserialize as NativeAgentLaunchRequest,
    AgentLaunchResponse as NativeAgentLaunchResponse,
    AgentResourceUsage as NativeAgentResourceUsage,
    ClaudeOAuthLoginStart as NativeClaudeOAuthLoginStart,
    CodexLoginStart as NativeCodexLoginStart,
    ConvertSubgraphToThreadResult,
    ImportLoginCandidateRequest as NativeImportLoginCandidateRequest,
    LoginImportCandidate as NativeLoginImportCandidate,
    LoginProfile as NativeLoginProfile,
    LoginProfilesChangedEvent as NativeLoginProfilesChangedEvent,
    ManagedRuntimeDoctorEntry,
    RuntimeModelCatalogCache,
    RuntimeModelCatalogRefreshResult,
    StartAgentRunIntent as NativeStartAgentRunIntent,
    StartAgentRunResponse as NativeStartAgentRunResponse,
    ThreadSessionPayload,
    UpsertLoginProfileRequest as NativeUpsertLoginProfileRequest,
} from '../generated/tauri-bindings';
export type {
    RuntimeModelCatalogCache,
    RuntimeModelCatalogRecord,
    RuntimeModelCatalogRefreshResult,
    RuntimeModelCatalogSnapshot,
} from '../generated/tauri-bindings';

const hasTauriRuntime = () =>
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

export interface LocalIdentity {
    localUserId: string;
    localDeviceId: string;
}

let localIdentityPromise: Promise<LocalIdentity> | null = null;

const getLocalIdentity = async (): Promise<LocalIdentity> => {
    if (!hasTauriRuntime()) {
        return {
            localUserId: import.meta.env.VITE_DEV_AUTH_USER_ID || '11111111-1111-1111-1111-111111111111',
            localDeviceId: 'web-local-device',
        };
    }
    localIdentityPromise ??= invoke<LocalIdentity>('get_local_identity');
    return localIdentityPromise;
};

const currentLocalUserId = async (): Promise<string> => {
    const identity = await getLocalIdentity();
    if (identity.localUserId) return identity.localUserId;
    if (import.meta.env.VITE_DEV_AUTH_BYPASS === 'true') {
        return import.meta.env.VITE_DEV_AUTH_USER_ID || '11111111-1111-1111-1111-111111111111';
    }
    throw new Error('Cannot use local storage without a local user id.');
};

export interface AgentRuntimeEventEnvelope {
    nodeId: string;
    event: Record<string, any>;
}

export interface WorkspaceInfo {
    repo_path: string;
    base_commit: string | null;
    needs_git_init: boolean;
    has_uncommitted_changes: boolean;
    changed_files: string[];
}

export interface CliToolStatus {
    installed: boolean;
    version: string | null;
    error: string | null;
}

export interface LocalEnvironmentStatus {
    git: CliToolStatus;
    codex: CliToolStatus;
    codex_auth: CliToolStatus;
    claude: CliToolStatus;
    claude_auth: CliToolStatus;
}

export interface ProviderSkill {
    id: string;
    name: string;
    description: string;
    provider: string;
    source: string;
    path: string;
}

export interface WorktreeInfo {
    node_id: string;
    worktree_path: string;
    branch_name: string;
    parent_commit: string;
}

export interface TargetBranchCheckoutStatus {
    checked_out: boolean;
    dirty: boolean;
}

export interface AgentWorktreeConfig {
    dependencyLinkDirs: string[];
    copyEnvFiles: boolean;
    envFilePatterns: string[];
    commitExcludePatterns: string[];
    blockDependencyMutationCommands: boolean;
}

export interface AgentWorktreeConfigStatus {
    config: AgentWorktreeConfig;
    configPath: string;
    source: 'default' | 'project' | string;
}

export const DEFAULT_AGENT_WORKTREE_CONFIG: AgentWorktreeConfig = {
    dependencyLinkDirs: ['node_modules', '.venv', 'venv', 'vendor', '.gradle', 'target'],
    copyEnvFiles: true,
    envFilePatterns: ['.env*'],
    commitExcludePatterns: [],
    blockDependencyMutationCommands: true,
};

const defaultAgentWorktreeConfigStatus = (repoPath: string): AgentWorktreeConfigStatus => ({
    config: { ...DEFAULT_AGENT_WORKTREE_CONFIG },
    configPath: `${repoPath.replace(/\/$/, '')}/.agentree/config.json`,
    source: 'default',
});

export interface AgentRunContext {
    runId: string;
    executionData: Record<string, any>;
    gitBranchName?: string | null;
    repoPath?: string | null;
    parentCommit?: string | null;
    authorName?: string | null;
    promptFallback?: string | null;
    authUserId?: string | null;
}

export interface TelemetryEventRow {
    eventType: string;
    data: string;
    timestamp: number;
}

export interface TelemetrySessionSnapshot {
    sessionId: string;
    status: string;
    createdAt: number;
    completedAt?: number | null;
    worktreePath?: string | null;
    repoPath?: string | null;
    events: TelemetryEventRow[];
}

export interface AgentRunStateResponse {
    ledger: Record<string, any> | null;
    running: boolean;
    pid: number | null;
}

export interface CloudSyncCapability {
    available: boolean;
    unavailableReason: string | null;
}

export interface AgentResourceUsage {
    assistantNodeId: string;
    rootPid: number;
    processCount: number;
    cpuPercent: number;
    memoryBytes: number;
    sampledAt: number;
}

export interface AgentRunJournalEvent {
    runId: string;
    assistantNodeId: string;
    seq: number;
    eventType: string;
    status?: string | null;
    phase?: string | null;
    payload: string;
    timestamp: number;
}

export interface LocalNodeRecord {
    nodeId: string;
    workspaceId: string;
    controlledByNodeId?: string | null;
    payload: string;
    syncStatus: 'local_only' | 'persisted';
    finalizedAt: number;
    serverAckAt?: number | null;
    retryAttempt: number;
    nextRetryAt?: number | null;
    lastUploadError?: string | null;
}

export interface LocalInsightRecord {
    insightId: string;
    workspaceId: string;
    payload: string;
    syncStatus: 'local_only' | 'persisted';
    createdAt: string;
    updatedAt: string;
    serverAckAt?: number | null;
    retryAttempt: number;
    nextRetryAt?: number | null;
    lastUploadError?: string | null;
}

export interface LocalInsightCandidateRecord {
    candidateId: string;
    workspaceId: string;
    parentNodeId: string;
    agentKind: 'hypothesis' | 'doubt' | 'meta' | 'association' | 'memory' | 'kb' | 'risk' | 'opportunity' | string;
    claim: string;
    rationale?: string | null;
    status: string;
    noveltyScore: number | null;
    relevanceScore: number | null;
    actionabilityScore: number | null;
    riskScore: number | null;
    timingScore: number | null;
    confidence: number | null;
    priority?: number | null;
    surfaceReason?: string | null;
    surfacedInsightId?: string | null;
    sourceRunNodeId?: string | null;
    explorationJson?: string | null;
    payload: string;
    createdAt: string;
    updatedAt: string;
}

export interface LocalSyncEventRecord {
    id: string;
    workspaceId?: string | null;
    userId?: string | null;
    cloudAccountId?: string | null;
    entityType: string;
    entityId: string;
    eventType: string;
    payloadJson: string;
    idempotencyKey: string;
    status: 'pending' | 'in_flight' | 'synced' | 'dead' | 'local_only';
    attemptCount: number;
    nextAttemptAt?: number | null;
    lastError?: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface LocalDeletedNodeRootRecord {
    workspaceId: string;
    nodeId: string;
    deletedAt: number;
}

export interface LocalWorkspaceRecord {
    id: string;
    name: string;
    userId: string;
    localRepoPath?: string | null;
    folderPath?: string | null;
    repoPath?: string | null;
    baseCommitSha?: string | null;
    connectionStatus: 'connected' | 'missing' | 'remote_unconnected' | 'path_mismatch' | string;
    syncStatus: 'sync_pending' | 'synced' | 'sync_error' | 'local_only' | string;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string | null;
    localUpdatedAt: number;
    serverWorkspaceId?: string | null;
    serverVersion?: string | null;
    nameDirty: boolean;
    metadataDirty: boolean;
    cloudBackupEnabled: boolean;
    cloudAccountId?: string | null;
}

export interface LocalWorkspaceMutationRequest {
    workspaceId: string;
    currentUserId: string;
    name?: string | null;
    localRepoPath?: string | null;
    baseCommitSha?: string | null;
    repoFingerprint?: string | null;
    mutationId?: string | null;
}

export interface LocalCommitImport {
    sha: string;
    parents: string[];
    subject?: string | null;
    authorName?: string | null;
    authorEmail?: string | null;
    authoredAt?: string | null;
    committedAt?: string | null;
    sourceKind?: 'agent' | 'external' | 'manual' | 'merge' | 'unknown' | string | null;
    producedByNodeId?: string | null;
    filesChangedCount?: number | null;
    totalAdditions?: number | null;
    totalDeletions?: number | null;
}

export interface LocalCommitGraphSnapshot {
    commits: Array<{
        sha: string;
        subject?: string | null;
        authorName?: string | null;
        authorEmail?: string | null;
        authoredAt?: string | null;
        committedAt?: string | null;
        sourceKind?: string | null;
        producedByNodeId?: string | null;
        firstParentSha?: string | null;
        filesChangedCount?: number | null;
        totalAdditions?: number | null;
        totalDeletions?: number | null;
        isMerged?: boolean;
    }>;
    commitParents: Array<{ childSha: string; parentSha: string; parentIndex: number }>;
    commitObservations: Array<{
        commitSha: string;
        gitRef?: string | null;
        sourceKind?: string | null;
        firstSeenAt?: string | null;
        lastSeenAt?: string | null;
    }>;
    pendingAcceptanceCandidates?: Array<{
        sourceSha: string;
        targetSha: string;
        gitRef: string;
        subject?: string | null;
    }>;
}

export interface CommitAcceptanceRefreshResult {
    changed: boolean;
    mergedCommitShas: string[];
    checkedRefs: string[];
    skippedRefs: string[];
    errors: string[];
    durationMs: number;
}

export type { ConvertSubgraphToThreadResult, ThreadSessionPayload };

export type StartAgentRunIntent = Omit<
    NativeStartAgentRunIntent,
    'workspaceId' | 'currentUserId' | 'traceId' | 'runContext'
> & {
    workspaceId?: string | null;
    currentUserId?: string | null;
    traceId?: string | null;
    runContext: AgentRunContext;
};

export type LoginProfile = Omit<NativeLoginProfile, 'config'> & {
    config: Record<string, any> | null;
};

export type UpsertLoginProfileRequest = Omit<
    NativeUpsertLoginProfileRequest,
    'id' | 'secret' | 'config' | 'makeDefault'
> & {
    id?: string | null;
    secret?: string | null;
    config?: Record<string, any> | null;
    makeDefault?: boolean | null;
};

export type LoginImportCandidate = NativeLoginImportCandidate;

export type ImportLoginCandidateRequest = Omit<
    NativeImportLoginCandidateRequest,
    'displayName' | 'makeDefault'
> & {
    displayName?: string | null;
    makeDefault?: boolean | null;
};

export type ActiveLoginProfileRun = NativeActiveLoginProfileRun;

export type LoginProfilesChangedEvent = NativeLoginProfilesChangedEvent;

export type CodexLoginStart = NativeCodexLoginStart;
export type ClaudeOAuthLoginStart = NativeClaudeOAuthLoginStart;
export type StartAgentRunResponse = NativeStartAgentRunResponse;

export type AgentLaunchRequest = Omit<
    NativeAgentLaunchRequest,
    | 'authToken'
    | 'currentUserId'
    | 'contextPolicy'
    | 'contextMode'
    | 'contextManifest'
    | 'modelCapabilities'
    | 'threadTitleMode'
    | 'userNode'
    | 'assistantNode'
> & {
    authToken: string;
    currentUserId?: string | null;
    contextPolicy?: 'continue' | 'fresh';
    contextMode?: 'active' | 'none';
    contextManifest?: Record<string, unknown> | null;
    modelCapabilities?: Record<string, unknown> | null;
    threadTitleMode?: 'first_thread_message' | 'none' | null;
    userNode: Record<string, unknown>;
    assistantNode: Record<string, unknown>;
};

export type AgentLaunchContext = NativeAgentLaunchContext;
export type AgentLaunchResponse = NativeAgentLaunchResponse;

const normalizeLoginProfile = (profile: NativeLoginProfile): LoginProfile => ({
    ...profile,
    config: profile.config && typeof profile.config === 'object' && !Array.isArray(profile.config)
        ? profile.config as Record<string, any>
        : null,
});

export interface GitMergePreview {
    has_conflicts: boolean;
    conflicted_files: string[];
    auto_mergeable_files: string[];
    merge_tree_sha: string | null;
    base_commit: string;
}

export type MergeReviewRunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export type MergeReviewRiskLevel = 'low' | 'medium' | 'high';
export type MergeReviewOverallVerdict = 'safe' | 'needs-attention' | 'blocked';

export interface MergeReviewSummary {
    overallVerdict: MergeReviewOverallVerdict;
    summaryText: string;
    riskLevel: MergeReviewRiskLevel;
    changedFilesCount: number;
    riskyFilesCount: number;
}

export interface MergeReviewIssueOption {
    id: string;
    label: string;
    kind: 'target' | 'source';
    sourceCommit?: string | null;
    sourceLabel?: string | null;
    description?: string | null;
}

export interface MergeReviewIssue {
    id: string;
    title: string;
    summary: string;
    riskLevel: MergeReviewRiskLevel;
    rationale: string;
    affectedFiles: string[];
    options: MergeReviewIssueOption[];
}

export interface MergeReviewResult {
    summary: MergeReviewSummary;
    issues: MergeReviewIssue[];
}

export interface MergeReviewTimelineEvent {
    timestamp: number;
    level: 'info' | 'warning' | 'error';
    message: string;
}

export interface MergeReviewEvent {
    runId: string;
    type: 'status' | 'timeline' | 'result' | 'error';
    status?: MergeReviewRunStatus;
    phase?: string | null;
    message?: string | null;
    event?: MergeReviewTimelineEvent | null;
    result?: MergeReviewResult | null;
    error?: string | null;
}

export interface MergeReviewFileInput {
    path: string;
    group: 'auto-apply' | 'conflicted';
}

export interface MergeReviewIssueSelection {
    issueId: string;
    optionId: string;
}

export interface MergeReviewRequest {
    repoPath: string;
    targetCommit: string;
    sourceCommits: string[];
    files: MergeReviewFileInput[];
    sourceLabels?: Record<string, string>;
    agentType: string;
    agentName?: string | null;
    cliArgs?: string | null;
    promptFlag?: string | null;
    selectedModelId?: string | null;
}

export interface MergeResolutionSynthesisRequest extends MergeReviewRequest {
    runId?: string | null;
    issues: MergeReviewIssue[];
    selections: MergeReviewIssueSelection[];
}

export interface MergeResolutionSynthesisResult {
    resolutions: ConflictResolution[];
    summaryText: string;
}

export interface GitMergeResult {
    status: 'clean' | 'resolved' | 'conflicts' | 'noop';
    commit_sha: string | null;
    conflicts: string[];
    merge_worktree_path: string | null;
    message?: string | null;
}

export interface GitBranchPointerInfo {
    name: string;
    commit_sha: string;
    git_ref: string;
}

export interface GitLocalRefInfo {
    git_ref: string;
    short_name: string;
    commit_sha: string;
    committed_at?: string | null;
}

export interface GitRefTipInfo {
    git_ref: string;
    commit_sha: string | null;
    error: string | null;
}

export interface GitRefSnapshot {
    head_sha: string | null;
    current_branch_ref: string | null;
    refs: GitRefTipInfo[];
}

export interface GitCommitMetadata {
    sha: string;
    parents: string[];
    subject: string;
    author_name: string | null;
    author_email: string | null;
    authored_at: string | null;
    files_changed_count?: number;
    files_added?: number;
    files_modified?: number;
    files_deleted?: number;
    total_additions?: number;
    total_deletions?: number;
}

export interface GitCommitRefLabel {
    git_ref: string;
    short_name: string;
    kind: string;
    is_current_branch: boolean;
}

export interface AddableCommitCandidate extends GitCommitMetadata {
    refs: GitCommitRefLabel[];
    is_head: boolean;
    is_ref_tip: boolean;
    is_known_graph_commit: boolean;
    ahead_count: number;
    rank_group: number;
}

export type DiffRelationship = 'parent-child' | 'ancestor-descendant' | 'siblings' | 'unrelated';
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'unchanged';

export interface DiffHunk {
    old_start: number;
    old_lines: number;
    new_start: number;
    new_lines: number;
    content: string;
}

export interface FileDiff {
    path: string;
    status: FileStatus;
    old_path?: string | null;
    additions: number;
    deletions: number;
    hunks?: DiffHunk[] | null;
    is_binary: boolean;
    size?: number | null;
    truncated?: boolean | null;
}

export interface DiffStats {
    files_added: number;
    files_modified: number;
    files_deleted: number;
    total_additions: number;
    total_deletions: number;
}

export interface DiffResult {
    from_node: string;
    to_node: string;
    common_ancestor?: string | null;
    relationship: DiffRelationship;
    files: FileDiff[];
    stats: DiffStats;
}

export interface ConflictResolution {
    path: string;
    action: 'source' | 'target' | 'base' | 'manual';
    content?: string | null;
    sourceCommit?: string | null;
}

export type ConflictType = 'content' | 'add-add' | 'modify-delete' | 'rename-rename';

// ═══════════════════════════════════════════════════════════════════════════
// BLAME TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface BlameEntry {
    line_start: number;
    line_end: number;
    content: string;
    author_node_id: string;
    is_base: boolean;
}

export interface BlameResult {
    node_id: string;
    file_path: string;
    total_lines: number;
    entries: BlameEntry[];
    file_hash: string | null;
    is_binary: boolean;
    file_exists: boolean;
    warnings: string[];
}

export interface ToolCallMatch {
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolOutput: string | null;
    timestamp: number;
    messageIndex: number;
}

export type ToolCallMatchType = 'exact' | 'heuristic' | 'fallback' | 'none';

export interface ContextMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    depth: number;
    createdAt: string;
}

export interface BlameContextResponse {
    node_id: string;
    file_path: string;
    path_ids: string[];
    agent_id: string | null;
    tool_call: ToolCallMatch | null;
    tool_call_match_type: ToolCallMatchType;
    context?: ContextMessage[];
    warnings: string[];
}

export const agentClient = {
    hasRuntime: hasTauriRuntime,
    getLocalIdentity,
    // ═══════════════════════════════════════════════════════════════════════
    // AGENT SPAWNING
    // ═══════════════════════════════════════════════════════════════════════

    setMcpAuthToken: async (token: string): Promise<void> => {
        await tauriCommands.setMcpAuthToken(token);
    },
    setMcpWorkspaceId: async (workspaceId: string): Promise<void> => {
        await tauriCommands.setMcpWorkspaceId(workspaceId);
    },
    getMcpServerUrl: async (): Promise<string> => {
        return await tauriCommands.getMcpServerUrl();
    },
    stopAgent: async (sessionId: string): Promise<void> => {
        await tauriCommands.stopAgent(sessionId);
    },
    steerAgentRun: async (assistantNodeId: string, content: string, idempotencyKey: string): Promise<void> => {
        await tauriCommands.steerAgentRun(assistantNodeId, content, idempotencyKey);
    },
    getAgentRunState: async (assistantNodeId: string): Promise<AgentRunStateResponse> => {
        return await tauriCommands.getAgentRunState(assistantNodeId);
    },
    listAgentResourceUsage: async (): Promise<AgentResourceUsage[]> => {
        if (!hasTauriRuntime()) return [];
        const rows: NativeAgentResourceUsage[] = await tauriCommands.listAgentResourceUsage();
        return rows.map((row) => ({
            ...row,
            cpuPercent: row.cpuPercent ?? 0,
        }));
    },
    replayAgentRunEvents: async (runId: string, afterSeq = 0): Promise<AgentRunJournalEvent[]> => {
        return await tauriCommands.replayAgentRunEvents(runId, afterSeq);
    },
    listLocalNodes: async (workspaceId: string): Promise<LocalNodeRecord[]> => {
        if (!hasTauriRuntime()) return [];
        return await tauriCommands.listLocalNodes(workspaceId) as LocalNodeRecord[];
    },
    listLocalInsights: async (workspaceId: string): Promise<LocalInsightRecord[]> => {
        if (!hasTauriRuntime()) return [];
        return await (tauriCommands as any).listLocalInsights(workspaceId) as LocalInsightRecord[];
    },
    listLocalInsightCandidates: async (workspaceId: string): Promise<LocalInsightCandidateRecord[]> => {
        if (!hasTauriRuntime()) return [];
        return await (tauriCommands as any).listLocalInsightCandidates(workspaceId) as LocalInsightCandidateRecord[];
    },
    upsertLocalInsight: async (workspaceId: string, insightId: string, payload: unknown, mutationId?: string | null): Promise<LocalSyncEventRecord | null> => {
        if (!hasTauriRuntime()) return null;
        return await (tauriCommands as any).upsertLocalInsight(
            workspaceId,
            await currentLocalUserId(),
            insightId,
            JSON.stringify(payload),
            mutationId ?? null
        ) as LocalSyncEventRecord;
    },
    localFirstDismissInsight: async (workspaceId: string, insightId: string): Promise<LocalSyncEventRecord | null> => {
        if (!hasTauriRuntime()) return null;
        return await (tauriCommands as any).localFirstDismissInsight(workspaceId, await currentLocalUserId(), insightId) as LocalSyncEventRecord;
    },
    recordLocalInsightFeedback: async (workspaceId: string, insightId: string, action: string, context?: unknown): Promise<void> => {
        if (!hasTauriRuntime()) return;
        await (tauriCommands as any).recordLocalInsightFeedback(
            workspaceId,
            await currentLocalUserId(),
            insightId,
            action,
            context === undefined ? null : JSON.stringify(context),
        );
    },
    hydrateLocalNodesFromServer: async (workspaceId: string, messages: unknown[]): Promise<number> => {
        if (!hasTauriRuntime()) return 0;
        const payloads = messages.map((message) => JSON.stringify(message));
        return await tauriCommands.hydrateLocalNodesFromServer(workspaceId, payloads);
    },
    upsertLocalNode: async (workspaceId: string, nodeId: string, message: unknown): Promise<void> => {
        if (!hasTauriRuntime()) return;
        await tauriCommands.upsertLocalNode(workspaceId, nodeId, JSON.stringify(message));
    },
    localFirstUpdateNodeTags: async (
        workspaceId: string,
        nodeId: string,
        tags: string[],
        action: 'add' | 'remove'
    ): Promise<unknown> => {
        const payload = await tauriCommands.localFirstUpdateNodeTags(
            workspaceId,
            await currentLocalUserId(),
            nodeId,
            tags,
            action
        );
        return JSON.parse(payload);
    },
    localFirstUpdateNodeHighlight: async (
        workspaceId: string,
        nodeId: string,
        action: 'add' | 'update' | 'delete',
        highlight: unknown
    ): Promise<unknown> => {
        const payload = await tauriCommands.localFirstUpdateNodeHighlight(
            workspaceId,
            await currentLocalUserId(),
            nodeId,
            action,
            JSON.stringify(highlight)
        );
        return JSON.parse(payload);
    },
    localFirstSetNodeCollapsed: async (
        workspaceId: string,
        nodeId: string,
        collapsed: boolean
    ): Promise<unknown> => {
        const payload = await tauriCommands.localFirstSetNodeCollapsed(
            workspaceId,
            await currentLocalUserId(),
            nodeId,
            collapsed
        );
        return JSON.parse(payload);
    },
    localFirstCreateThreadSession: async (payload: ThreadSessionPayload): Promise<ThreadSessionPayload> => {
        return await tauriCommands.localFirstCreateThreadSession(
            await currentLocalUserId(),
            payload
        ) as ThreadSessionPayload;
    },
    convertSubgraphToThread: async (input: {
        workspaceId: string;
        rootNodeId: string;
        idempotencyKey: string;
        targetThreadId: string;
    }): Promise<ConvertSubgraphToThreadResult> => {
        if (!hasTauriRuntime()) throw new Error('Local runtime is unavailable.');
        return await (tauriCommands as any).convertSubgraphToThread(
            input.workspaceId,
            input.rootNodeId,
            input.idempotencyKey,
            input.targetThreadId,
            await currentLocalUserId(),
        ) as ConvertSubgraphToThreadResult;
    },
    listThreadSessions: async (workspaceId: string): Promise<ThreadSessionPayload[]> => {
        if (!hasTauriRuntime()) return [];
        return await (tauriCommands as any).listThreadSessions(workspaceId) as ThreadSessionPayload[];
    },
    localFirstDeleteThreadSession: async (workspaceId: string, threadId: string): Promise<void> => {
        await tauriCommands.localFirstDeleteThreadSession(
            await currentLocalUserId(),
            workspaceId,
            threadId
        );
    },
    importLocalCommits: async (workspaceId: string, commits: LocalCommitImport[], gitRef?: string | null, repoPath?: string | null): Promise<number> => {
        if (!hasTauriRuntime()) return 0;
        return await tauriCommands.importLocalCommits(
            workspaceId,
            commits.map((commit) => ({
                sha: commit.sha,
                parents: commit.parents,
                subject: commit.subject ?? null,
                authorName: commit.authorName ?? null,
                authorEmail: commit.authorEmail ?? null,
                authoredAt: commit.authoredAt ?? null,
                committedAt: commit.committedAt ?? null,
                sourceKind: commit.sourceKind ?? null,
                producedByNodeId: commit.producedByNodeId ?? null,
                filesChangedCount: commit.filesChangedCount ?? null,
                totalAdditions: commit.totalAdditions ?? null,
                totalDeletions: commit.totalDeletions ?? null,
            })),
            gitRef ?? null,
            repoPath ?? null
        );
    },
    listLocalCommitGraph: async (workspaceId: string): Promise<LocalCommitGraphSnapshot> => {
        if (!hasTauriRuntime()) return { commits: [], commitParents: [], commitObservations: [], pendingAcceptanceCandidates: [] };
        return await tauriCommands.listLocalCommitGraph(workspaceId) as LocalCommitGraphSnapshot;
    },
    refreshLocalCommitAcceptance: async (
        workspaceId: string,
        repoPath: string,
        acceptedGitRefs: string[]
    ): Promise<CommitAcceptanceRefreshResult> => {
        if (!hasTauriRuntime()) {
            return {
                changed: false,
                mergedCommitShas: [],
                checkedRefs: [],
                skippedRefs: [],
                errors: [],
                durationMs: 0,
            };
        }
        return await tauriCommands.refreshLocalCommitAcceptance(
            workspaceId,
            repoPath,
            acceptedGitRefs
        ) as CommitAcceptanceRefreshResult;
    },
    resolveLocalCommitAcceptance: async (
        workspaceId: string,
        gitRef: string,
        sourceSha: string,
        targetSha: string,
        accepted: boolean
    ): Promise<boolean> => {
        if (!hasTauriRuntime()) return false;
        return await tauriCommands.resolveLocalCommitAcceptance(
            workspaceId,
            gitRef,
            sourceSha,
            targetSha,
            accepted
        );
    },
    repairLocalCommitGraph: async (workspaceId: string, repoPath: string, gitRef?: string | null): Promise<number> => {
        if (!hasTauriRuntime()) return 0;
        return await tauriCommands.repairLocalCommitGraph(workspaceId, repoPath, gitRef ?? null);
    },
    enqueueLocalCommitGraphSync: async (workspaceId: string, payload: unknown, mutationId?: string | null): Promise<LocalSyncEventRecord | null> => {
        if (!hasTauriRuntime()) return null;
        return await tauriCommands.enqueueLocalCommitGraphSync(
            workspaceId,
            await currentLocalUserId(),
            JSON.stringify(payload),
            mutationId ?? null
        ) as LocalSyncEventRecord;
    },
    localFirstDeleteBranch: async (workspaceId: string, rootNodeId: string): Promise<LocalSyncEventRecord | null> => {
        if (!hasTauriRuntime()) return null;
        return await tauriCommands.localFirstDeleteBranch(workspaceId, await currentLocalUserId(), rootNodeId) as LocalSyncEventRecord;
    },
    localFirstDeleteWorkspace: async (workspaceId: string): Promise<LocalSyncEventRecord | null> => {
        if (!hasTauriRuntime()) return null;
        return await tauriCommands.localFirstDeleteWorkspace(workspaceId, await currentLocalUserId()) as LocalSyncEventRecord;
    },
    listLocalWorkspaces: async (activeCloudAccountId?: string | null): Promise<LocalWorkspaceRecord[]> => {
        if (!hasTauriRuntime()) return [];
        return await invoke<LocalWorkspaceRecord[]>('list_local_workspaces', {
            currentUserId: await currentLocalUserId(),
            activeCloudAccountId: activeCloudAccountId ?? null,
        });
    },
    mergeServerWorkspaces: async (workspaces: unknown[], cloudAccountId: string): Promise<LocalWorkspaceRecord[]> => {
        if (!hasTauriRuntime()) return [];
        return await invoke<LocalWorkspaceRecord[]>('merge_server_workspaces', {
            currentUserId: await currentLocalUserId(),
            cloudAccountId,
            payloads: workspaces.map((workspace) => JSON.stringify(workspace)),
        });
    },
    localFirstCreateWorkspace: async (
        request: Omit<LocalWorkspaceMutationRequest, 'currentUserId'>
    ): Promise<LocalWorkspaceRecord> => {
        return await invoke<LocalWorkspaceRecord>('local_first_create_workspace', {
            request: {
                ...request,
                currentUserId: await currentLocalUserId(),
            },
        });
    },
    localFirstRenameWorkspace: async (workspaceId: string, name: string): Promise<LocalWorkspaceRecord> => {
        return await invoke<LocalWorkspaceRecord>('local_first_rename_workspace', {
            workspaceId,
            currentUserId: await currentLocalUserId(),
            name,
        });
    },
    localFirstReconnectWorkspace: async (
        request: Omit<LocalWorkspaceMutationRequest, 'currentUserId'>
    ): Promise<LocalWorkspaceRecord> => {
        return await invoke<LocalWorkspaceRecord>('local_first_reconnect_workspace', {
            request: {
                ...request,
                currentUserId: await currentLocalUserId(),
            },
        });
    },
    enableWorkspaceCloudBackup: async (workspaceId: string, cloudAccountId: string): Promise<LocalWorkspaceRecord> => {
        return await tauriCommands.enableWorkspaceCloudBackup(
            workspaceId,
            await currentLocalUserId(),
            cloudAccountId,
        );
    },
    listLocalDeletedNodeRoots: async (workspaceId: string): Promise<LocalDeletedNodeRootRecord[]> => {
        if (!hasTauriRuntime()) return [];
        return await tauriCommands.listLocalDeletedNodeRoots(workspaceId);
    },
    listLocalDeletedWorkspaceIds: async (): Promise<string[]> => {
        if (!hasTauriRuntime()) return [];
        return await tauriCommands.listLocalDeletedWorkspaceIds();
    },
    getCloudSyncCapability: async (): Promise<CloudSyncCapability> => {
        if (!hasTauriRuntime()) return { available: true, unavailableReason: null };
        return await tauriCommands.getCloudSyncCapability();
    },
    getNextLocalSyncRetryAt: async (cloudAccountId: string): Promise<number | null> => {
        if (!hasTauriRuntime()) return null;
        return await tauriCommands.getNextLocalSyncRetryAt(
            await currentLocalUserId(),
            cloudAccountId,
        );
    },
    processLocalSyncEvents: async (
        authToken: string,
        cloudAccountId: string,
        limit = 25,
        workspaceId: string | null = null,
        bootstrapOnly = false,
    ): Promise<number> => {
        if (!hasTauriRuntime()) return 0;
        return await tauriCommands.processLocalSyncEvents(
            authToken,
            await currentLocalUserId(),
            cloudAccountId,
            workspaceId,
            bootstrapOnly,
            limit,
        );
    },
    startAgentRun: async (intent: StartAgentRunIntent): Promise<StartAgentRunResponse> => {
        const currentUserId = intent.currentUserId ?? await currentLocalUserId();
        return await tauriCommands.startAgentRun({
            ...intent,
            currentUserId,
            workspaceId: intent.workspaceId ?? null,
            runContext: {
                ...intent.runContext,
                authUserId: intent.runContext.authUserId ?? currentUserId,
            },
            loginProfileId: intent.loginProfileId ?? null,
            traceId: intent.traceId ?? null,
        });
    },
    launchAgentMessage: async (request: AgentLaunchRequest): Promise<AgentLaunchResponse> => {
        const currentUserId = request.currentUserId ?? await currentLocalUserId();
        return await tauriCommands.launchAgentMessage({
            ...request,
            currentUserId,
            contextManifest: request.contextManifest ?? {},
            modelCapabilities: request.modelCapabilities ?? {},
        });
    },
    listLoginProfiles: async (): Promise<LoginProfile[]> => {
        if (!hasTauriRuntime()) return [];
        return (await tauriCommands.listLoginProfiles()).map(normalizeLoginProfile);
    },
    readOpenCodeLoginProfileAuth: async (profileId: string): Promise<string> => {
        return await tauriCommands.readOpencodeLoginProfileAuth(profileId);
    },
    upsertLoginProfile: async (request: UpsertLoginProfileRequest): Promise<LoginProfile> => {
        const profile = await tauriCommands.upsertLoginProfile({
            ...request,
            id: request.id ?? null,
            secret: request.secret ?? null,
            config: request.config ?? null,
            makeDefault: request.makeDefault ?? null,
        });
        return normalizeLoginProfile(profile);
    },
    deleteLoginProfile: async (profileId: string): Promise<void> => {
        await tauriCommands.deleteLoginProfile(profileId);
    },
    setDefaultLoginProfile: async (provider: string, profileId: string | null): Promise<LoginProfile[]> => {
        return (await tauriCommands.setDefaultLoginProfile(provider, profileId)).map(normalizeLoginProfile);
    },
    checkLoginProfileReadiness: async (profileId: string, providers?: string[] | null): Promise<LoginProfile> => {
        return normalizeLoginProfile(await tauriCommands.checkLoginProfileReadiness(profileId, providers ?? null));
    },
    // Compatibility name: the native launch preflight is local-only and never probes a provider.
    ensureLoginProfileReady: async (profileId: string): Promise<LoginProfile> => {
        return normalizeLoginProfile(await tauriCommands.ensureLoginProfileReady(profileId));
    },
    connectCodexLoginProfile: async (profileId: string): Promise<CodexLoginStart> => {
        return await tauriCommands.connectCodexLoginProfile(profileId);
    },
    connectClaudeOauthLoginProfile: async (profileId: string): Promise<ClaudeOAuthLoginStart> => {
        return await tauriCommands.connectClaudeOauthLoginProfile(profileId);
    },
    pollClaudeOauthLoginProfile: async (profileId: string): Promise<LoginProfile> => {
        return normalizeLoginProfile(await tauriCommands.pollClaudeOauthLoginProfile(profileId));
    },
    submitClaudeOauthLoginCode: async (profileId: string, code: string): Promise<LoginProfile> => {
        return normalizeLoginProfile(await tauriCommands.submitClaudeOauthLoginCode(profileId, code));
    },
    checkAllLoginProfileReadiness: async (): Promise<LoginProfile[]> => {
        if (!hasTauriRuntime()) return [];
        return (await tauriCommands.checkAllLoginProfileReadiness()).map(normalizeLoginProfile);
    },
    listActiveLoginProfileRuns: async (): Promise<ActiveLoginProfileRun[]> => {
        if (!hasTauriRuntime()) return [];
        return await tauriCommands.listActiveLoginProfileRuns();
    },
    importExistingRuntimeLogin: async (provider: string, displayName: string): Promise<LoginProfile> => {
        return normalizeLoginProfile(await tauriCommands.importExistingRuntimeLogin(provider, displayName));
    },
    discoverLoginImportCandidates: async (): Promise<LoginImportCandidate[]> => {
        if (!hasTauriRuntime()) return [];
        return await tauriCommands.discoverLoginImportCandidates();
    },
    importDiscoveredLoginProfile: async (request: ImportLoginCandidateRequest): Promise<LoginProfile> => {
        return normalizeLoginProfile(await tauriCommands.importDiscoveredLoginProfile({
            ...request,
            displayName: request.displayName ?? null,
            makeDefault: request.makeDefault ?? null,
        }));
    },

    onEvent: async (callback: (event: AgentRuntimeEventEnvelope) => void): Promise<UnlistenFn> => {
        return await listen<AgentRuntimeEventEnvelope>('agent:event', (event) => {
            callback(event.payload);
        });
    },
    onLoginProfilesChanged: async (callback: (event: LoginProfilesChangedEvent) => void): Promise<UnlistenFn> => {
        if (!hasTauriRuntime()) return () => {};
        return await tauriEvents.loginProfilesChanged.listen((event) => {
            callback(event.payload);
        });
    },
    onRuntimeModelCatalogChanged: async (callback: (event: RuntimeModelCatalogCache) => void): Promise<UnlistenFn> => {
        if (!hasTauriRuntime()) return () => {};
        return await listen<RuntimeModelCatalogCache>('runtime-model-catalog:changed', (event) => {
            callback(event.payload);
        });
    },
    onMergeReviewEvent: async (callback: (event: MergeReviewEvent) => void): Promise<UnlistenFn> => {
        return await listen<MergeReviewEvent>('integration:merge-review-event', (event) => {
            callback(event.payload);
        });
    },

    // ═══════════════════════════════════════════════════════════════════════
    // WORKSPACE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    checkLocalEnvironment: async (): Promise<LocalEnvironmentStatus> => {
        return await invoke('check_local_environment');
    },
    getRuntimeModelCatalogs: async (opencodeProfileId?: string | null): Promise<RuntimeModelCatalogCache> => {
        if (!hasTauriRuntime()) {
            return { supported: [], opencodeAccessible: null, staleProviders: [] };
        }
        return await tauriCommands.getRuntimeModelCatalogs(opencodeProfileId ?? null);
    },
    refreshRuntimeModelCatalogs: async (): Promise<RuntimeModelCatalogRefreshResult> => {
        if (!hasTauriRuntime()) {
            return {
                cache: { supported: [], opencodeAccessible: null, staleProviders: [] },
                failures: [],
            };
        }
        return await tauriCommands.refreshRuntimeModelCatalogs();
    },
    checkManagedRuntimeDoctor: async (forceFingerprint = false): Promise<ManagedRuntimeDoctorEntry[]> => {
        if (!hasTauriRuntime()) return [];
        return await tauriCommands.checkManagedRuntimeDoctor(forceFingerprint);
    },
    repairManagedRuntimeComponent: async (component: string): Promise<ManagedRuntimeDoctorEntry> => {
        return await tauriCommands.repairManagedRuntimeComponent(component);
    },
    attachWorkspace: async (path: string): Promise<WorkspaceInfo> => {
        return await tauriCommands.attachWorkspace(path);
    },
    initGitRepo: async (repoPath: string): Promise<string> => {
        return await tauriCommands.initGitRepo(repoPath);
    },
    commitUncommitted: async (repoPath: string, message: string): Promise<string> => {
        return await tauriCommands.commitUncommitted(repoPath, message);
    },
    createBaseBranch: async (repoPath: string): Promise<string> => {
        return await tauriCommands.createBaseBranch(repoPath);
    },
    previewAgentWorktree: async (repoPath: string, nodeId: string, parentCommit: string): Promise<WorktreeInfo> => {
        return await tauriCommands.previewAgentWorktree(repoPath, nodeId, parentCommit);
    },
    getAgentWorktreeConfig: async (repoPath: string): Promise<AgentWorktreeConfigStatus> => {
        if (!hasTauriRuntime()) return defaultAgentWorktreeConfigStatus(repoPath);
        return await invoke<AgentWorktreeConfigStatus>('get_agent_worktree_config', { repoPath });
    },
    getAgentSandboxRoot: async (): Promise<string | null> => {
        if (!hasTauriRuntime()) return null;
        return await invoke<string>('get_agent_sandbox_root');
    },
    saveAgentWorktreeConfig: async (repoPath: string, config: AgentWorktreeConfig): Promise<AgentWorktreeConfigStatus> => {
        if (!hasTauriRuntime()) {
            return { ...defaultAgentWorktreeConfigStatus(repoPath), config: { ...config }, source: 'project' };
        }
        return await invoke<AgentWorktreeConfigStatus>('save_agent_worktree_config', { repoPath, config });
    },
    checkoutCommitDetached: async (repoPath: string, commitSha: string): Promise<string> => {
        return await tauriCommands.checkoutCommitDetached(repoPath, commitSha);
    },
    targetBranchCheckoutStatus: async (repoPath: string, targetBranch: string): Promise<TargetBranchCheckoutStatus> => {
        return await tauriCommands.targetBranchCheckoutStatus(repoPath, targetBranch);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // TELEMETRY DATABASE
    // ═══════════════════════════════════════════════════════════════════════

    createSessionDb: async (sessionId: string): Promise<string> => {
        return await invoke('create_session_db', { sessionId });
    },

    recordToolCall: async (
        sessionId: string,
        name: string,
        parameters: string | null,
        result: string | null,
        error: string | null,
        startedAt: number,
        completedAt: number
    ): Promise<number> => {
        return await invoke('record_tool_call', {
            sessionId,
            name,
            parameters,
            result,
            error,
            startedAt,
            completedAt
        });
    },

    kvSet: async (sessionId: string, key: string, value: string): Promise<void> => {
        return await invoke('kv_set', { sessionId, key, value });
    },

    kvGet: async (sessionId: string, key: string): Promise<string | null> => {
        return await invoke('kv_get', { sessionId, key });
    },

    addMessage: async (
        sessionId: string,
        role: string,
        content: string,
        metadata?: string
    ): Promise<number> => {
        return await invoke('add_message', { sessionId, role, content, metadata });
    },

    updateSessionStatus: async (sessionId: string, status: string): Promise<void> => {
        return await invoke('update_session_status', { sessionId, status });
    },
    getSessionSnapshot: async (sessionId: string): Promise<TelemetrySessionSnapshot | null> => {
        return await invoke('get_session_snapshot', { sessionId });
    },

    // ═══════════════════════════════════════════════════════════════════════
    // GIT DIFF API
    // ═══════════════════════════════════════════════════════════════════════
    diffCommits: async (
        repoPath: string,
        fromCommit: string,
        toCommit: string,
        includeContent: boolean = false
    ): Promise<DiffResult> => {
        return await tauriCommands.diffCommits(repoPath, fromCommit, toCommit, includeContent) as DiffResult;
    },
    diffFileBetweenCommits: async (
        repoPath: string,
        fromCommit: string,
        toCommit: string,
        filePath: string
    ): Promise<FileDiff> => {
        return await tauriCommands.diffFileBetweenCommits(repoPath, fromCommit, toCommit, filePath) as FileDiff;
    },
    showFileAtCommit: async (repoPath: string, commit: string, filePath: string): Promise<string> => {
        return await tauriCommands.showFileAtCommit(repoPath, commit, filePath);
    },
    listFilesAtCommit: async (repoPath: string, commit: string): Promise<string[]> => {
        return await tauriCommands.listFilesAtCommit(repoPath, commit);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BLAME API
    // ═══════════════════════════════════════════════════════════════════════
    computeGitBlame: async (repoPath: string, commit: string, filePath: string): Promise<BlameResult> => {
        return await tauriCommands.gitComputeBlame(repoPath, commit, filePath) as BlameResult;
    },
    mergePreview: async (repoPath: string, sourceBranches: string[], targetBranch: string): Promise<GitMergePreview> => {
        return await tauriCommands.mergePreview(repoPath, sourceBranches, targetBranch) as GitMergePreview;
    },
    startMergeReview: async (request: MergeReviewRequest): Promise<{ runId: string }> => {
        return await tauriCommands.startMergeReview({
            ...request,
            sourceLabels: request.sourceLabels ?? null,
        } as any);
    },
    synthesizeMergeResolutions: async (request: MergeResolutionSynthesisRequest): Promise<MergeResolutionSynthesisResult> => {
        return await tauriCommands.synthesizeMergeResolutions({
            ...request,
            sourceLabels: request.sourceLabels ?? null,
            runId: request.runId ?? null,
        } as any) as MergeResolutionSynthesisResult;
    },
    stopMergeReview: async (runId: string): Promise<void> => {
        await tauriCommands.stopMergeReview(runId);
    },
    isMergeReviewRunning: async (runId: string): Promise<boolean> => {
        return await tauriCommands.isMergeReviewRunning(runId);
    },
    mergeApply: async (
        repoPath: string, 
        sourceBranches: string[], 
        targetBranch: string, 
        nodeId: string, 
        commitMessage: string,
        conflictResolutions?: ConflictResolution[]
    ): Promise<GitMergeResult> => {
        return await tauriCommands.gitMergeApply(
            repoPath,
            sourceBranches,
            targetBranch,
            nodeId,
            commitMessage,
            (conflictResolutions ?? null) as any
        ) as GitMergeResult;
    },
    createBranchPointer: async (repoPath: string, pointerName: string, commitSha: string): Promise<string> => {
        return await tauriCommands.createBranchPointer(repoPath, pointerName, commitSha);
    },
    deleteBranchPointer: async (repoPath: string, pointerName: string): Promise<void> => {
        await tauriCommands.deleteBranchPointer(repoPath, pointerName);
    },
    moveBranchPointer: async (repoPath: string, pointerName: string, newCommitSha: string): Promise<void> => {
        await tauriCommands.moveBranchPointer(repoPath, pointerName, newCommitSha);
    },
    updateGitRef: async (repoPath: string, gitRef: string, newCommitSha: string, expectedCurrentSha?: string | null): Promise<void> => {
        await tauriCommands.updateGitRef(repoPath, gitRef, newCommitSha, expectedCurrentSha ?? null);
    },
    listBranchPointers: async (repoPath: string): Promise<GitBranchPointerInfo[]> => {
        return await tauriCommands.listBranchPointers(repoPath) as GitBranchPointerInfo[];
    },
    listLocalRefs: async (repoPath: string): Promise<GitLocalRefInfo[]> => {
        return await tauriCommands.listLocalRefs(repoPath) as GitLocalRefInfo[];
    },
    snapshotGitRefs: async (repoPath: string, gitRefs: string[]): Promise<GitRefSnapshot> => {
        return await tauriCommands.snapshotGitRefs(repoPath, gitRefs) as GitRefSnapshot;
    },
    resolveRefTip: async (repoPath: string, gitRef: string): Promise<string> => {
        return await tauriCommands.resolveRefTip(repoPath, gitRef);
    },
    resolveCurrentBranchRef: async (repoPath: string): Promise<string | null> => {
        return await tauriCommands.resolveCurrentBranchRef(repoPath);
    },
    listMissingCommits: async (
        repoPath: string,
        fromCommit: string | null,
        toCommit: string,
        limit?: number | null
    ): Promise<GitCommitMetadata[]> => {
        return await tauriCommands.listMissingCommits(repoPath, fromCommit, toCommit, limit ?? null) as GitCommitMetadata[];
    },
    readCommitMetadata: async (repoPath: string, commitSha: string): Promise<GitCommitMetadata> => {
        return await tauriCommands.readCommitMetadata(repoPath, commitSha) as GitCommitMetadata;
    },
    listAddableCommitCandidates: async (
        repoPath: string,
        baseCommit: string,
        limit?: number,
        knownGraphCommits?: string[]
    ): Promise<AddableCommitCandidate[]> => {
        return await tauriCommands.listAddableCommitCandidates(
            repoPath,
            baseCommit,
            limit ?? null,
            knownGraphCommits ?? null
        ) as AddableCommitCandidate[];
    },
    listAddableCommitRange: async (
        repoPath: string,
        baseCommit: string,
        tipCommit: string,
        limit?: number | null
    ): Promise<GitCommitMetadata[]> => {
        return await tauriCommands.listAddableCommitRange(repoPath, baseCommit, tipCommit, limit ?? null) as GitCommitMetadata[];
    },
    listAllCommits: async (repoPath: string, limit?: number, exclusions?: string[], excludeDescendantsOf?: string): Promise<GitCommitMetadata[]> => {
        return await tauriCommands.listAllCommits(
            repoPath,
            limit ?? null,
            exclusions ?? null,
            excludeDescendantsOf ?? null
        ) as GitCommitMetadata[];
    },
    listProviderSkills: async (providers: string[], repoPath?: string | null): Promise<ProviderSkill[]> => {
        return await (tauriCommands as any).listProviderSkills(providers, repoPath ?? null) as ProviderSkill[];
    },

};
