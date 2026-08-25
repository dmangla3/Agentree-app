export const DEFAULT_MCP_SERVER_URL = 'http://127.0.0.1:61337/mcp';

export const appendClaudeMcpConfigArgs = (args: string[], mcpServerUrl: string): string[] => {
  if (args.includes('--mcp-config')) {
    return args;
  }

  const mcpConfig = JSON.stringify({
    mcpServers: {
      agentree: {
        type: 'http',
        url: mcpServerUrl || DEFAULT_MCP_SERVER_URL,
      },
    },
  });

  return [...args, '--mcp-config', mcpConfig, '--strict-mcp-config'];
};
