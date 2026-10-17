import { describe, expect, it } from 'vitest';
import { graphNodeTypes } from './graphNodeTypes';

describe('graphNodeTypes', () => {
  it('registers virtual thread origins with React Flow', () => {
    expect(graphNodeTypes.thread_origin).toBe(graphNodeTypes.user_message);
  });
});
