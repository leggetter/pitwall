// Claude Code's handling of a large MCP result, for the supervisor (W184; W186's F3).
import { describe, expect, it } from 'vitest';
import { outputLimitEnvironment, savedToolResult, SUPERVISOR_MCP_OUTPUT_TOKENS } from './claudeOutput.js';

describe('claudeOutput', () => {
  it('cuts results at 11,000 tokens rather than saving them to a file', () => {
    expect(SUPERVISOR_MCP_OUTPUT_TOKENS).toBe(11_000);
    expect(outputLimitEnvironment()).toEqual({ MAX_MCP_OUTPUT_TOKENS: '11000', ENABLE_MCP_LARGE_OUTPUT_FILES: '0' });
  });

  it('tells a result Claude Code saved to a file from one it passed on, in either shape', () => {
    expect(savedToolResult('<persisted-output>\nOutput too large (200KB). Full output saved to: /x/tool-results/mcp-a-b-1.txt')).toBe(true);
    expect(savedToolResult([{ type: 'text', text: 'Full output saved to: /x/tool-results/toolu_1.json\nPreview (first 2KB):' }])).toBe(true);
    expect(savedToolResult('alpha bravo charlie')).toBe(false);
    expect(savedToolResult(`${'x'.repeat(1000)} <persisted-output>`)).toBe(false);
    expect(savedToolResult(undefined)).toBe(false);
  });
});
