export const MAX_INLINE_TOOL_OUTPUT_BYTES = 256 * 1024;
export const TOOL_OUTPUT_TRUNCATION_NOTICE = '\n\n[Output truncated. Refine the command.]\n\n';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const contentBudget = MAX_INLINE_TOOL_OUTPUT_BYTES - encoder.encode(TOOL_OUTPUT_TRUNCATION_NOTICE).byteLength;
const headBudget = Math.floor(contentBudget / 2);
const tailBudget = contentBudget - headBudget;

const utf8Prefix = (bytes: Uint8Array, byteBudget: number): string => {
  if (bytes.byteLength <= byteBudget) return decoder.decode(bytes);
  let end = byteBudget;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
};

const utf8Suffix = (bytes: Uint8Array, byteBudget: number): string => {
  if (bytes.byteLength <= byteBudget) return decoder.decode(bytes);
  let start = bytes.byteLength - byteBudget;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
};

export const boundToolOutput = (value: string): string => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_INLINE_TOOL_OUTPUT_BYTES) return value;
  return `${utf8Prefix(bytes, headBudget)}${TOOL_OUTPUT_TRUNCATION_NOTICE}${utf8Suffix(bytes, tailBudget)}`;
};

export const appendBoundedToolOutput = (current: string, incoming: string): string => {
  if (!incoming) return boundToolOutput(current);
  if (!current) return boundToolOutput(incoming);

  const currentBytes = encoder.encode(current);
  const noticeIndex = currentBytes.byteLength >= MAX_INLINE_TOOL_OUTPUT_BYTES - 8
    ? current.indexOf(TOOL_OUTPUT_TRUNCATION_NOTICE)
    : -1;
  if (noticeIndex !== -1) {
    return current;
  }

  if (incoming.startsWith(current)) return boundToolOutput(incoming);
  if (current.startsWith(incoming) || current.endsWith(incoming)) return boundToolOutput(current);

  const incomingBytes = encoder.encode(incoming);
  if (currentBytes.byteLength + incomingBytes.byteLength <= MAX_INLINE_TOOL_OUTPUT_BYTES) {
    return `${current}${incoming}`;
  }

  const head = currentBytes.byteLength >= headBudget
    ? utf8Prefix(currentBytes, headBudget)
    : `${current}${utf8Prefix(incomingBytes, headBudget - currentBytes.byteLength)}`;
  const tail = incomingBytes.byteLength >= tailBudget
    ? utf8Suffix(incomingBytes, tailBudget)
    : `${utf8Suffix(currentBytes, tailBudget - incomingBytes.byteLength)}${incoming}`;
  return `${head}${TOOL_OUTPUT_TRUNCATION_NOTICE}${tail}`;
};

export const sanitizeTimelineToolOutputs = (timeline: any[]): any[] => {
  let changed = false;
  const sanitized = timeline.map((event) => {
    if (!event || typeof event !== 'object') return event;
    const outputKey = typeof event.toolOutput === 'string'
      ? 'toolOutput'
      : (typeof event.tool_output === 'string' ? 'tool_output' : null);
    if (!outputKey) return event;
    const output = event[outputKey];
    const bounded = boundToolOutput(output);
    if (bounded === output) return event;
    changed = true;
    return { ...event, [outputKey]: bounded };
  });
  return changed ? sanitized : timeline;
};
