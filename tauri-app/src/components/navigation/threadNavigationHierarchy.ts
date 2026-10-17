import type { ThreadNavigationItem } from '../graph/GraphControls';

/**
 * Show newer thread families first without reversing descendants ahead of
 * their parents. The graph supplies depth; this helper only establishes a
 * stable parent-before-child traversal for the navigator.
 */
export function orderThreadFamiliesNewestFirst(
  items: ThreadNavigationItem[],
): ThreadNavigationItem[] {
  const updatedAt = (item: ThreadNavigationItem) => item.lastUpdatedAt ?? 0;
  const itemById = new Map(items.map((item) => [item.threadRootId, item]));
  const childrenByParentId = new Map<string, ThreadNavigationItem[]>();
  const roots: ThreadNavigationItem[] = [];

  for (const item of items) {
    if (item.parentThreadId && itemById.has(item.parentThreadId)) {
      const siblings = childrenByParentId.get(item.parentThreadId) ?? [];
      siblings.push(item);
      childrenByParentId.set(item.parentThreadId, siblings);
    } else {
      roots.push(item);
    }
  }

  const subtreeUpdatedAt = new Map<string, number>();
  const calculateSubtreeUpdatedAt = (item: ThreadNavigationItem, visiting: Set<string>): number => {
    const cached = subtreeUpdatedAt.get(item.threadRootId);
    if (cached !== undefined) return cached;
    if (visiting.has(item.threadRootId)) return updatedAt(item);
    const nextVisiting = new Set(visiting).add(item.threadRootId);
    const latestUpdatedAt = (childrenByParentId.get(item.threadRootId) ?? []).reduce(
      (latest, child) => Math.max(latest, calculateSubtreeUpdatedAt(child, nextVisiting)),
      updatedAt(item),
    );
    subtreeUpdatedAt.set(item.threadRootId, latestUpdatedAt);
    return latestUpdatedAt;
  };
  const newestFirst = (left: ThreadNavigationItem, right: ThreadNavigationItem) => (
    calculateSubtreeUpdatedAt(right, new Set()) - calculateSubtreeUpdatedAt(left, new Set())
      || updatedAt(right) - updatedAt(left)
      || left.label.localeCompare(right.label)
  );

  roots.sort(newestFirst);
  for (const children of childrenByParentId.values()) children.sort(newestFirst);

  const ordered: ThreadNavigationItem[] = [];
  const visited = new Set<string>();
  const append = (item: ThreadNavigationItem) => {
    if (visited.has(item.threadRootId)) return;
    visited.add(item.threadRootId);
    ordered.push(item);
    for (const child of childrenByParentId.get(item.threadRootId) ?? []) append(child);
  };
  for (const root of roots) append(root);
  for (const item of items) append(item);
  return ordered;
}
