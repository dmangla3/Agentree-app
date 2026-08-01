import { Message } from '../../stores/workspaceStore';
import { getMessageOutputCommitSha } from './commitAccessors';

const getExecutionData = (msg: Message): Record<string, unknown> | undefined => {
  return msg.execution_data as Record<string, unknown> | undefined;
};

const stringValue = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
);

const uniqueIds = (ids: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const normalized = typeof id === 'string' ? id.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export interface MergeVisualParentEntry {
  id: string;
  commitSha: string | null;
  label: string | null;
  role: 'Target' | 'Source' | 'Parent';
  source: 'merge_metadata' | 'commit_parents';
  index: number;
}

const getMessageCommitSha = (msg: Message): string | null => {
  return getMessageOutputCommitSha(msg);
};

const getGitParentShas = (msg: Message): string[] => {
  if (!Array.isArray(msg.commit?.parents)) return [];
  return uniqueIds(msg.commit.parents.map((parent) => stringValue(parent.parent_sha)));
};

const resolveCommitNodeId = (
  commitSha: string | null,
  messageMap?: Map<string, Message>,
  currentMessageId?: string,
): string | null => {
  if (!commitSha || !messageMap) return null;

  let latestCandidate: Message | null = null;
  for (const candidate of messageMap.values()) {
    if (candidate.id === currentMessageId) continue;
    if (getMessageCommitSha(candidate) !== commitSha) continue;
    if (!latestCandidate) {
      latestCandidate = candidate;
      continue;
    }
    const candidateTime = new Date(candidate.createdAt).getTime();
    const latestTime = new Date(latestCandidate.createdAt).getTime();
    if (candidateTime > latestTime) {
      latestCandidate = candidate;
    }
  }

  return latestCandidate?.id ?? null;
};

export const getGraphParentId = (
  msg: Message,
  messageMap?: Map<string, Message>,
): string | null => {
  void messageMap;
  return msg.parentId ?? null;
};

export const getMergeVisualParentIds = (
  msg: Message,
  messageMap?: Map<string, Message>,
): string[] => {
  return getMergeVisualParentEntries(msg, messageMap).map((entry) => entry.id);
};

export const getMergeVisualParentEntries = (
  msg: Message,
  messageMap?: Map<string, Message>,
): MergeVisualParentEntry[] => {
  const executionData = getExecutionData(msg);
  const mergeMetadata = executionData?.merge_metadata as Record<string, unknown> | undefined;

  if (mergeMetadata) {
    const entries: MergeVisualParentEntry[] = [];
    const labelByNodeId = new Map<string, { label: string | null; role: 'Target' | 'Source'; commitSha: string | null }>();
    const target = mergeMetadata.target as Record<string, unknown> | undefined;
    const targetId = stringValue(target?.nodeId);
    if (targetId) {
      labelByNodeId.set(targetId, {
        label: stringValue(target?.label),
        role: 'Target',
        commitSha: stringValue(target?.commitSha),
      });
    }

    if (Array.isArray(mergeMetadata.sources)) {
      for (const source of mergeMetadata.sources) {
        const sourceRecord = source as Record<string, unknown> | undefined;
        const sourceId = stringValue(sourceRecord?.nodeId);
        if (!sourceId) continue;
        labelByNodeId.set(sourceId, {
          label: stringValue(sourceRecord?.label),
          role: 'Source',
          commitSha: stringValue(sourceRecord?.commitSha),
        });
      }
    }

    const explicit = Array.isArray(mergeMetadata.visual_parent_node_ids)
      ? mergeMetadata.visual_parent_node_ids.map(stringValue)
      : [];
    const sourceIds = Array.isArray(mergeMetadata.sources)
      ? mergeMetadata.sources.map((source) => stringValue((source as Record<string, unknown> | undefined)?.nodeId))
      : [];
    const ids = uniqueIds([...explicit, targetId, ...sourceIds]).filter((id) => (
      id !== msg.id && (!messageMap || messageMap.has(id))
    ));

    ids.forEach((id, index) => {
      const labeled = labelByNodeId.get(id);
      const parentMessage = messageMap?.get(id) ?? null;
      entries.push({
        id,
        commitSha: labeled?.commitSha ?? (parentMessage ? getMessageCommitSha(parentMessage) : null),
        label: labeled?.label ?? null,
        role: labeled?.role ?? 'Source',
        source: 'merge_metadata',
        index,
      });
    });

    return entries;
  }

  const gitParentShas = getGitParentShas(msg);
  if (gitParentShas.length <= 1 || !messageMap) return [];

  return gitParentShas
    .map((commitSha, index): MergeVisualParentEntry | null => {
      const id = resolveCommitNodeId(commitSha, messageMap, msg.id);
      if (!id) return null;
      return {
        id,
        commitSha,
        label: index === 0 ? 'First parent' : `Parent ${index + 1}`,
        role: 'Parent',
        source: 'commit_parents',
        index,
      };
    })
    .filter((entry): entry is MergeVisualParentEntry => Boolean(entry));
};

export const isMergeResultNode = (
  msg: Message,
  messageMap?: Map<string, Message>,
): boolean => {
  return getMergeVisualParentIds(msg, messageMap).length > 0;
};

export const getExplicitContextParentId = (
  msg: Message,
  messageMap?: Map<string, Message>,
): string | null => {
  const executionData = getExecutionData(msg);
  const meta = (executionData?.meta as Record<string, unknown> | undefined) || {};
  const contextParentId =
    stringValue(meta.context_parent_node_id) ||
    stringValue((executionData?.context_profile as Record<string, unknown> | undefined)?.context_parent_node_id);
  if (!contextParentId || contextParentId === msg.id) return null;
  if (messageMap && !messageMap.has(contextParentId)) return null;
  return contextParentId;
};

export const getInheritedContextParentId = (
  startId: string | null | undefined,
  messageMap: Map<string, Message>,
): string | null => {
  let cursorId = startId || null;
  const visited = new Set<string>();
  while (cursorId && !visited.has(cursorId)) {
    visited.add(cursorId);
    const message = messageMap.get(cursorId);
    if (!message) return null;
    const explicit = getExplicitContextParentId(message, messageMap);
    if (explicit) return explicit;
    cursorId = message.parentId ?? null;
  }
  return null;
};

export const getAssistantLineageParent = (
  msg: Message,
  messageMap: Map<string, Message>,
): Message | null => {
  const graphParentId = getGraphParentId(msg, messageMap);
  if (!graphParentId) return null;

  const graphParent = messageMap.get(graphParentId);
  if (!graphParent) return null;
  if (graphParent.role === 'assistant') return graphParent;

  if (graphParent.role === 'user' && graphParent.parentId) {
    const assistantParent = messageMap.get(graphParent.parentId);
    if (assistantParent?.role === 'assistant') {
      return assistantParent;
    }
  }

  return null;
};
