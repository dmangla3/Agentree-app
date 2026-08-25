import { describe, expect, it } from 'vitest';
import { appendClaudeMcpConfigArgs } from './mcpRuntime';

describe('appendClaudeMcpConfigArgs', () => {
  it('uses the runtime MCP URL when adding Claude MCP config', () => {
    const args = appendClaudeMcpConfigArgs(['--permission-mode', 'auto'], 'http://127.0.0.1:61234/mcp');

    const configIndex = args.indexOf('--mcp-config');
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[configIndex + 1])).toEqual({
      mcpServers: {
        agentree: {
          type: 'http',
          url: 'http://127.0.0.1:61234/mcp',
        },
      },
    });
    expect(args).toContain('--strict-mcp-config');
  });

  it('does not replace an explicit MCP config', () => {
    const args = appendClaudeMcpConfigArgs(['--mcp-config', '{"mcpServers":{}}'], 'http://127.0.0.1:61234/mcp');

    expect(args).toEqual(['--mcp-config', '{"mcpServers":{}}']);
  });
});
