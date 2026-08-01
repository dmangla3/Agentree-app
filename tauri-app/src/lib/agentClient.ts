import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { commands as tauriCommands } from '../generated/tauri-bindings';

const hasTauriRuntime = () =>
    typeof window !== 'undefined' &&
    Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

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

export type RuntimeReadinessStatus =
    | 'ready'
    | 'cli_missing'
    | 'cli_not_executable'
    | 'auth_missing'
    | 'keychain_unavailable'
    | 'usage_limit_exceeded'
    | 'unknown_error';

export type RuntimeProvider = 'codex' | 'claude' | 'gemini' | string;

export interface RuntimeReadiness {
    provider: RuntimeProvider;
    status: RuntimeReadinessStatus;
    cliPath?: string | null;
    cliVersion?: string | null;
    homeDir?: string | null;
    authMode?: 'chatgpt' | 'api_key' | 'file' | 'keychain' | string | null;
    planType?: string | null;
    hasAuthFile?: boolean | null;
    hasOpenaiApiKey?: boolean;
    hasCodexApiKey?: boolean;
    recommendedCommand?: string | null;
    message: string;
    diagnostics?: Record<string, unknown>;
    loginStatus?: {
        ok?: boolean;
        exit_code?: number;
        output_excerpt?: string;
        error_type?: string;
    };
}

export type CodexReadinessStatus = RuntimeReadinessStatus;
export type CodexReadiness = RuntimeReadiness;

export interface WorktreeInfo {
    node_id: string;
    worktree_path: string;
    branch_name: string;
    parent_commit: string;
}

export interface AgentRunContext {
    runId: string;
    executionData: Record<string, any>;
    gitBranchName?: string | null;
    repoPath?: string | null;
    parentCommit?: string | null;
    authorName?: string | null;
    promptFallback?: string | null;
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
    payload: string;
    syncStatus: 'local_only' | 'persisted';
    finalizedAt: number;
    serverAckAt?: number | null;
    retryAttempt: number;
    nextRetryAt?: number | null;
    lastUploadError?: string | null;
}

export interface LocalSyncEventRecord {
    id: string;
    workspaceId?: string | null;
    entityType: string;
    entityId: string;
    eventType: string;
    payloadJson: string;
    idempotencyKey: string;
    status: 'pending' | 'in_flight' | 'synced' | 'dead';
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

export interface StartAgentRunIntent {
    runId: string;
    assistantNodeId: string;
    workspaceId?: string | null;
    repoPath: string;
    parentCommit: string;
    agentType: string;
    args: string[];
    authToken: string;
    traceId?: string | null;
    runContext: AgentRunContext;
}

export interface StartAgentRunResponse {
    runId: string;
    assistantNodeId: string;
    worktreePath: string;
    branchName: string;
    pid: number | null;
    initialStatus: string;
}

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

export interface SkillSummary {
    id: string;
    name: string;
    description: string;
    installed: boolean;
    source: string;
    path?: string | null;
}

export interface SkillProgressEvent {
    op_id: string;
    operation: string;
    skill_id?: string | null;
    stage: string;
    message: string;
    done: boolean;
    error: boolean;
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
    // ═══════════════════════════════════════════════════════════════════════
    // AGENT SPAWNING
    // ═══════════════════════════════════════════════════════════════════════

    setMcpAuthToken: async (token: string): Promise<void> => {
        await tauriCommands.setMcpAuthToken(token);
    },
    setMcpWorkspaceId: async (workspaceId: string): Promise<void> => {
        await tauriCommands.setMcpWorkspaceId(workspaceId);
    },
    getSkillStorePath: async (): Promise<string> => {
        return await tauriCommands.getSkillStorePath();
    },
    listInstalledSkills: async (opId?: string): Promise<SkillSummary[]> => {
        return await tauriCommands.listInstalledSkills(opId ?? null);
    },
    searchCatalogSkills: async (query: string, opId?: string): Promise<SkillSummary[]> => {
        return await tauriCommands.searchCatalogSkills(query, opId ?? null);
    },
    installCatalogSkill: async (skillId: string, opId?: string): Promise<SkillSummary> => {
        return await tauriCommands.installCatalogSkill(skillId, opId ?? null);
    },
    deleteInstalledSkill: async (skillId: string, opId?: string): Promise<void> => {
        await tauriCommands.deleteInstalledSkill(skillId, opId ?? null);
    },
    stopAgent: async (sessionId: string): Promise<void> => {
        await tauriCommands.stopAgent(sessionId);
    },
    getAgentRunState: async (assistantNodeId: string): Promise<AgentRunStateResponse> => {
        return await tauriCommands.getAgentRunState(assistantNodeId);
    },
    replayAgentRunEvents: async (runId: string, afterSeq = 0): Promise<AgentRunJournalEvent[]> => {
        return await tauriCommands.replayAgentRunEvents(runId, afterSeq);
    },
    listLocalNodes: async (workspaceId: string): Promise<LocalNodeRecord[]> => {
        if (!hasTauriRuntime()) return [];
        return await tauriCommands.listLocalNodes(workspaceId) as LocalNodeRecord[];
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
    localFirstDeleteBranch: async (workspaceId: string, rootNodeId: string): Promise<LocalSyncEventRecord | null> => {
        if (!hasTauriRuntime()) return null;
        return await tauriCommands.localFirstDeleteBranch(workspaceId, rootNodeId) as LocalSyncEventRecord;
    },
    localFirstDeleteWorkspace: async (workspaceId: string): Promise<LocalSyncEventRecord | null> => {
        if (!hasTauriRuntime()) return null;
        return await tauriCommands.localFirstDeleteWorkspace(workspaceId) as LocalSyncEventRecord;
    },
    listLocalDeletedNodeRoots: async (workspaceId: string): Promise<LocalDeletedNodeRootRecord[]> => {
        if (!hasTauriRuntime()) return [];
        return await tauriCommands.listLocalDeletedNodeRoots(workspaceId);
    },
    listLocalDeletedWorkspaceIds: async (): Promise<string[]> => {
        if (!hasTauriRuntime()) return [];
        return await tauriCommands.listLocalDeletedWorkspaceIds();
    },
    processLocalSyncEvents: async (authToken: string, limit = 25): Promise<number> => {
        if (!hasTauriRuntime()) return 0;
        return await tauriCommands.processLocalSyncEvents(authToken, limit);
    },
    startAgentRun: async (intent: StartAgentRunIntent): Promise<StartAgentRunResponse> => {
        return await tauriCommands.startAgentRun({
            ...intent,
            workspaceId: intent.workspaceId ?? null,
        } as any);
    },

    onEvent: async (callback: (event: AgentRuntimeEventEnvelope) => void): Promise<UnlistenFn> => {
        return await listen<AgentRuntimeEventEnvelope>('agent:event', (event) => {
            callback(event.payload);
        });
    },
    onSkillProgress: async (callback: (event: SkillProgressEvent) => void): Promise<UnlistenFn> => {
        return await listen<SkillProgressEvent>('skills:progress', (event) => {
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
    checkRuntimeReadiness: async (provider: RuntimeProvider): Promise<RuntimeReadiness> => {
        if (!hasTauriRuntime()) {
            return {
                provider,
                status: 'ready',
                message: 'Browser preview runtime bypass is active.',
                diagnostics: { browserPreview: true },
            };
        }
        return await tauriCommands.checkRuntimeReadiness(provider) as RuntimeReadiness;
    },
    checkAllRuntimeReadiness: async (): Promise<RuntimeReadiness[]> => {
        return await tauriCommands.checkAllRuntimeReadiness() as RuntimeReadiness[];
    },
    checkCodexReadiness: async (): Promise<CodexReadiness> => {
        return await tauriCommands.checkRuntimeReadiness('codex') as CodexReadiness;
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
    checkoutCommitDetached: async (repoPath: string, commitSha: string): Promise<string> => {
        return await tauriCommands.checkoutCommitDetached(repoPath, commitSha);
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

};
