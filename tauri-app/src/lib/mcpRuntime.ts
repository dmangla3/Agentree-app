export const appendClaudeMcpConfigArgs = (args: string[], mcpServerUrl: string): string[] => {
  if (args.includes('--mcp-config')) {
    return args;
  }

  const url = mcpServerUrl.trim();
  if (!url) {
    throw new Error('Agentree MCP server URL is unavailable. Restart Agentree and try again.');
  }

  const mcpConfig = JSON.stringify({
    mcpServers: {
      agentree: {
        type: 'http',
        url,
      },
    },
  });

  return [...args, '--mcp-config', mcpConfig, '--strict-mcp-config'];
};
