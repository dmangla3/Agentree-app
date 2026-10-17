import type { Message } from '../stores/workspaceStore';

const readString = (record: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

export const getControlledByNodeId = (
  message: Pick<Message, 'controlled_by_node_id' | 'controlledByNodeId' | 'execution_data'>,
): string | null => {
  const direct = readString(message as Record<string, unknown>, ['controlled_by_node_id', 'controlledByNodeId']);
  if (direct) return direct;
  const executionData = message.execution_data && typeof message.execution_data === 'object'
    ? message.execution_data as Record<string, unknown>
    : {};
  const meta = executionData.meta && typeof executionData.meta === 'object'
    ? executionData.meta as Record<string, unknown>
    : {};
  return readString(meta, ['controlled_by_node_id', 'controlledByNodeId']);
};
