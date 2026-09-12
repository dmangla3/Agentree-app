import { describe, expect, it } from 'vitest';
import { graphNodeTypes } from './graphNodeTypes';

describe('graphNodeTypes', () => {
  it('registers virtual thread origins with React Flow', () => {
    expect(graphNodeTypes.thread_origin).toBe(graphNodeTypes.user_message);
  });

  it('routes collapsed orchestration nodes through the shared graph dispatcher', () => {
    expect(graphNodeTypes.orchestration_node).toBe(graphNodeTypes.assistant_message);
  });
});
