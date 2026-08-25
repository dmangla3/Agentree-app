import type { Message } from '../stores/workspaceStore';
import { classifyMessageNodeKind } from './nodes';

export interface DeleteBranchPreview {
  rootCount: number;
  totalCount: number;
  userCount: number;
  assistantCount: number;
  commitCount: number;
  typeSummary: string;
  threadLabel: string | null;
  rootLabels: DeleteBranchPreviewItem[];
  groups: DeleteBranchPreviewGroups;
}

const pluralize = (count: number, singular: string, plural = `${singular}s`) => (
  `${count} ${count === 1 ? singular : plural}`
);

export interface DeleteBranchPreviewItem {
  id: string;
  label: string;
}

export interface DeleteBranchPreviewGroups {
  user: DeleteBranchPreviewItem[];
  assistant: DeleteBranchPreviewItem[];
  commit: DeleteBranchPreviewItem[];
  other: DeleteBranchPreviewItem[];
}

export interface DeleteBranchPreviewOptions {
  threadLabel?: string | null;
  extraCommitLabels?: string[];
}

const MAX_DETAIL_LABEL_LENGTH = 68;

const cleanPreviewLabel = (value: string | null | undefined): string => (
  (value || '')
    .replace(/```[\s\S]*?```/g, '[Code]')
    .replace(/`[^`]+`/g, '[Code]')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/\s+/g, ' ')
    .trim()
);

const truncatePreviewLabel = (value: string): string => {
  if (value.length <= MAX_DETAIL_LABEL_LENGTH) return value;
  const hardCut = value.slice(0, MAX_DETAIL_LABEL_LENGTH - 3);
  const lastSpaceIndex = hardCut.lastIndexOf(' ');
  const cut = lastSpaceIndex > 40 ? hardCut.slice(0, lastSpaceIndex) : hardCut;
  return `${cut}...`;
};

const labelForMessage = (message: Message): string => (
  truncatePreviewLabel(cleanPreviewLabel(message.aiLabel) || cleanPreviewLabel(message.content) || message.id)
);

export function getTopLevelDeleteBranchIds(
  messageIds: Iterable<string>,
  messageMap: Map<string, Message>
): string[] {
  const selectedArray = Array.from(new Set(messageIds)).filter((id) => messageMap.has(id));
  const selectedSet = new Set(selectedArray);

  return selectedArray.filter((id) => {
    let currentId = messageMap.get(id)?.parentId ?? null;
    while (currentId) {
      if (selectedSet.has(currentId)) return false;
      currentId = messageMap.get(currentId)?.parentId ?? null;
    }
    return true;
  });
}

export function collectDeleteBranchMessageIds(
  rootMessageIds: Iterable<string>,
  messageMap: Map<string, Message>
): Set<string> {
  const topLevelRootIds = getTopLevelDeleteBranchIds(rootMessageIds, messageMap);
  const childrenByParentId = new Map<string, string[]>();

  for (const message of messageMap.values()) {
    if (!message.parentId) continue;
    const children = childrenByParentId.get(message.parentId) ?? [];
    children.push(message.id);
    childrenByParentId.set(message.parentId, children);
  }

  const impactedIds = new Set<string>();
  const stack = [...topLevelRootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (impactedIds.has(id)) continue;
    const message = messageMap.get(id);
    if (!message) continue;
    impactedIds.add(id);
    stack.push(...(childrenByParentId.get(id) ?? []));
  }

  return impactedIds;
}

export function getDeleteBranchPreview(
  rootMessageIds: Iterable<string>,
  messageMap: Map<string, Message>,
  extraCommitCount = 0,
  options: DeleteBranchPreviewOptions = {}
): DeleteBranchPreview {
  const topLevelRootIds = getTopLevelDeleteBranchIds(rootMessageIds, messageMap);
  const impactedIds = collectDeleteBranchMessageIds(topLevelRootIds, messageMap);

  let userCount = 0;
  let assistantCount = 0;
  let commitCount = extraCommitCount;
  const groups: DeleteBranchPreviewGroups = {
    user: [],
    assistant: [],
    commit: [],
    other: [],
  };

  for (const id of impactedIds) {
    const message = messageMap.get(id);
    if (!message) continue;
    const kind = classifyMessageNodeKind(message, messageMap);
    const item = { id, label: labelForMessage(message) };
    if (kind === 'user_message') {
      userCount += 1;
      groups.user.push(item);
    } else if (kind === 'assistant_message') {
      assistantCount += 1;
      groups.assistant.push(item);
    } else if (kind === 'commit_message') {
      commitCount += 1;
      groups.commit.push(item);
    } else {
      groups.other.push(item);
    }
  }

  const extraCommitLabels = options.extraCommitLabels ?? [];
  for (let index = 0; index < extraCommitCount; index += 1) {
    const label = extraCommitLabels[index]
      ? `Commit ${truncatePreviewLabel(cleanPreviewLabel(extraCommitLabels[index]))}`
      : extraCommitCount === 1
        ? 'Selected commit node'
        : `Selected commit node ${index + 1}`;
    groups.commit.push({
      id: `extra-commit-${index}`,
      label,
    });
  }

  const typeParts = [
    userCount > 0 ? pluralize(userCount, 'user node') : null,
    assistantCount > 0 ? pluralize(assistantCount, 'assistant node') : null,
    commitCount > 0 ? pluralize(commitCount, 'commit node') : null,
  ].filter((part): part is string => Boolean(part));

  return {
    rootCount: topLevelRootIds.length,
    totalCount: impactedIds.size + extraCommitCount,
    userCount,
    assistantCount,
    commitCount,
    typeSummary: typeParts.length > 0 ? typeParts.join(', ') : '0 loaded nodes',
    threadLabel: options.threadLabel ? truncatePreviewLabel(cleanPreviewLabel(options.threadLabel)) : null,
    rootLabels: topLevelRootIds
      .map((id) => {
        const message = messageMap.get(id);
        return message ? { id, label: labelForMessage(message) } : null;
      })
      .filter((item): item is DeleteBranchPreviewItem => Boolean(item)),
    groups,
  };
}

export function formatDeleteBranchPreview(preview: DeleteBranchPreview): string {
  if (preview.rootCount === 0 && preview.commitCount > 0) {
    return `This will permanently remove ${pluralize(preview.commitCount, 'commit node')} from the graph. This action cannot be undone.`;
  }

  const rootLabel = pluralize(preview.rootCount, 'selected branch', 'selected branches');
  const totalLabel = pluralize(preview.totalCount, 'total node');
  return `This will permanently delete ${rootLabel} and ${totalLabel}: ${preview.typeSummary}. This action cannot be undone.`;
}
