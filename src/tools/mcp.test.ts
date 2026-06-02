import { describe, expect, it } from 'vitest';
import { AlwaysAllow } from '../permission/permission.js';
import type { MCPSession } from './mcp.js';
import { MCPTool } from './mcp.js';

describe('MCPTool', () => {
  it('formats text MCP errors without raw content JSON', async () => {
    const session = {
      serverName: 'browser',
      callTool: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'Error: WebSocket response timeout after 30000ms' }],
      }),
    } as unknown as MCPSession;
    const tool = new MCPTool(
      session,
      'mcp_browser_browser_click',
      'browser_click',
      'Click in browser',
      { type: 'object' },
    );

    await expect(tool.run({}, new AbortController().signal, new AlwaysAllow())).rejects.toThrow(
      'Browser Click failed: WebSocket response timeout after 30000ms',
    );
    await expect(tool.run({}, new AbortController().signal, new AlwaysAllow())).rejects.not.toThrow(
      'isError',
    );
  });
});
