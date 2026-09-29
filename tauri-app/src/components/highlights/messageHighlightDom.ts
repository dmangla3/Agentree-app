export const HIGHLIGHT_CONTENT_ROOT_SELECTOR = '[data-agentree-highlight-content-root="true"]';
export const HIGHLIGHT_SCROLL_CONTAINER_SELECTOR = '[data-agentree-highlight-scroll-container="true"]';

export const getHighlightRootForNode = (node: Node | null): HTMLElement | null => {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest<HTMLElement>(HIGHLIGHT_CONTENT_ROOT_SELECTOR) ?? null;
};

export const getTextOffsetInHighlightRoot = (
  root: HTMLElement,
  targetNode: Node,
  targetOffset: number
): number | null => {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node === targetNode) {
      return offset + targetOffset;
    }
    offset += node.textContent?.length ?? 0;
  }
  return null;
};

export const createRangeFromHighlightOffsets = (
  root: HTMLElement,
  start: number,
  end: number
): Range | null => {
  const ownerDocument = root.ownerDocument;
  const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const nodeStart = offset;
    const nodeEnd = nodeStart + node.data.length;
    if (!startNode && start >= nodeStart && start <= nodeEnd) {
      startNode = node;
      startOffset = start - nodeStart;
    }
    if (!endNode && end >= nodeStart && end <= nodeEnd) {
      endNode = node;
      endOffset = end - nodeStart;
      break;
    }
    offset = nodeEnd;
  }

  if (!startNode || !endNode) return null;
  const range = ownerDocument.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
};
