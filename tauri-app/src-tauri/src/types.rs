//! Shared data types for git diff and merge operations.

use serde::{Deserialize, Serialize};

/// Maximum file size in bytes for full diff content.
pub const MAX_FILE_BYTES: usize = 5 * 1024 * 1024; // 5MB per file

/// Maximum total bytes for unified diff output.
pub const MAX_DIFF_BYTES: usize = 10 * 1024 * 1024; // 10MB total

// ═══════════════════════════════════════════════════════════════════════════
// DIFF TYPES
// ═══════════════════════════════════════════════════════════════════════════

/// Relationship between two nodes in the tree.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DiffRelationship {
    ParentChild,
    AncestorDescendant,
    Siblings,
    Unrelated,
}

/// Status of a file in a diff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Unchanged,
}

/// Result of comparing two nodes.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DiffResult {
    pub from_node: String,
    pub to_node: String,
    pub common_ancestor: Option<String>,
    pub relationship: DiffRelationship,
    pub files: Vec<FileDiff>,
    pub stats: DiffStats,
}

/// Diff information for a single file.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FileDiff {
    pub path: String,
    pub status: FileStatus,
    pub old_path: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Option<Vec<DiffHunk>>,
    pub is_binary: bool,
    pub size: Option<u64>,
    pub truncated: Option<bool>,
}

/// A hunk in a unified diff.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub content: String,
}

/// Statistics for a diff operation.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
pub struct DiffStats {
    pub files_added: usize,
    pub files_modified: usize,
    pub files_deleted: usize,
    pub total_additions: usize,
    pub total_deletions: usize,
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFLICT TYPES
// ═══════════════════════════════════════════════════════════════════════════

/// Type of conflict detected during merge.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictType {
    /// Textual content conflict (both sides modified differently).
    Content,
    /// Both sides added different content for the same path.
    AddAdd,
    /// One side modified, the other deleted.
    ModifyDelete,
    /// Both sides renamed to different paths.
    RenameRename,
    /// Binary files cannot be auto-merged.
    BinaryConflict,
}

/// Information about a merge conflict.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ConflictInfo {
    pub path: String,
    #[serde(rename = "type")]
    pub type_: ConflictType,
    pub base: Option<String>,
    pub source: Option<String>,
    pub target: Option<String>,
    pub is_binary: bool,
    pub truncated: Option<bool>,
}

/// How to resolve a conflict.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ResolutionAction {
    /// Use the source version.
    Source,
    /// Keep the target version.
    Target,
    /// Revert to the base (common ancestor) version.
    Base,
    /// Use manually provided content.
    Manual,
}

/// User-provided resolution for a conflict.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ConflictResolution {
    pub path: String,
    pub action: ResolutionAction,
    pub content: Option<String>,
    #[serde(rename = "sourceCommit", skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
}

// ═══════════════════════════════════════════════════════════════════════════
// MERGE TYPES (NEW)
// ═══════════════════════════════════════════════════════════════════════════

/// An endpoint in a merge operation: can be a base commit, workspace branch, or node branch.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum MergeEndpoint {
    /// Immutable base branch/commit for the conversation.
    BaseSnapshot { project_id: String },
    /// User's attached repository.
    Workspace { project_id: String },
    /// Git branch for a specific node.
    Node { project_id: String, node_id: String },
}

/// Request to preview a merge operation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MergeRequest {
    pub base: MergeEndpoint,
    pub source: MergeEndpoint,
    pub target: MergeEndpoint,
    #[serde(default)]
    pub options: MergeOptions,
}

/// Options for merge operations.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MergeOptions {
    /// Include file content in preview (more expensive).
    #[serde(default)]
    pub include_content: bool,
    /// Verify target hasn't changed since preview before applying.
    #[serde(default = "default_true")]
    pub verify_target_unchanged: bool,
    /// Allow replacing binary files without conflict.
    #[serde(default)]
    pub allow_binary_replace: bool,
    /// Maximum bytes per file to include in preview.
    #[serde(default = "default_max_bytes")]
    pub max_bytes: usize,
    /// Paths to ignore during merge.
    #[serde(default)]
    pub ignore_patterns: Vec<String>,
}

fn default_true() -> bool {
    true
}
fn default_max_bytes() -> usize {
    MAX_FILE_BYTES
}

impl Default for MergeOptions {
    fn default() -> Self {
        Self {
            include_content: false,
            verify_target_unchanged: true,
            allow_binary_replace: false,
            max_bytes: MAX_FILE_BYTES,
            ignore_patterns: vec![],
        }
    }
}

/// Preview of what a merge would do.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MergePreview {
    pub plan_id: String,
    pub base: MergeEndpoint,
    pub source: MergeEndpoint,
    pub target: MergeEndpoint,
    pub conflicts: Vec<ConflictInfo>,
    pub auto_mergeable: Vec<FileDiff>,
    pub can_auto_merge: bool,
    pub stats: DiffStats,
    pub created_at: i64,
}

/// Request to apply a merge.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MergeApplyRequest {
    pub preview: MergePreview,
    pub resolutions: Vec<ConflictResolution>,
    #[serde(default)]
    pub options: MergeOptions,
}

/// Result of applying a merge.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MergeApplyResult {
    pub plan_id: String,
    pub files_applied: usize,
    pub files_failed: usize,
    pub partial: bool,
    pub errors: Vec<String>,
    /// ID of the new merge node (for immutable merges into Node targets).
    pub result_node_id: Option<String>,
}

// ═══════════════════════════════════════════════════════════════════════════
// QUICK PREVIEW TYPES (Tiered Diff - Phase 1)
// ═══════════════════════════════════════════════════════════════════════════

/// Quick preview result (hash-based, no content reads).
#[derive(Debug, Clone, Serialize, Deserialize, Default, specta::Type)]
pub struct QuickPreview {
    pub plan_id: String,
    pub base: Option<MergeEndpoint>,
    pub source: Option<MergeEndpoint>,
    pub target: Option<MergeEndpoint>,
    pub unchanged_count: usize,
    pub added: Vec<FileInfo>,
    pub deleted: Vec<FileInfo>,
    pub modified: Vec<FileInfo>,
    /// Paths that need conflict analysis (both sides changed from base).
    pub potential_conflicts: Vec<String>,
}

/// Basic file info for quick preview.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
    /// Fingerprint for comparison (size:mtime or hash).
    pub fingerprint: String,
}

/// Result of analyzing potential conflicts (Phase 2).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ConflictAnalysis {
    pub path: String,
    pub is_auto_mergeable: bool,
    pub conflict_type: Option<ConflictType>,
    /// Merged content if auto-mergeable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_content: Option<Vec<u8>>,
}

/// Detailed diff for a single file (on-demand, Phase 3).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FileDiffDetail {
    pub path: String,
    pub source_content: Option<String>,
    pub target_content: Option<String>,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLY STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════════

/// State of an ongoing or completed merge apply operation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ApplyState {
    pub plan_id: String,
    pub started_at: i64,
    pub status: ApplyStatus,
    pub operations: Vec<FileOperation>,
    pub current_index: usize,
    pub error: Option<String>,
    /// Serialized MergeEndpoint for the target.
    pub target: MergeEndpoint,
}

/// Status of an apply operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ApplyStatus {
    InProgress,
    Completed,
    Failed,
    RolledBack,
}

/// A single file operation in a merge apply.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FileOperation {
    pub path: String,
    pub op_type: OpType,
    pub status: OpStatus,
    /// Path to backup in rollback directory.
    pub backup_path: Option<String>,
    /// Content to write (for Write operations).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<u8>>,
    pub error: Option<String>,
}

/// Type of file operation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum OpType {
    Write,
    Delete,
    Mkdir,
}

/// Status of a file operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum OpStatus {
    Pending,
    Applied,
    Failed,
    RolledBack,
}
