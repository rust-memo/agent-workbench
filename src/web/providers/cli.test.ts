import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../../llm/types.js';
import { parseOpenClaudeOutput, parseStructuredEnvelope } from './cli.js';

const request: ChatRequest = {
  model: 'test',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'scope_targets',
        description: 'test',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
};

describe('CLI provider structured output', () => {
  it('accepts only strict actions from the advertised registry', () => {
    const parsed = parseStructuredEnvelope(
      JSON.stringify({
        assistantText: 'starting',
        toolCalls: [{ name: 'scope_targets', arguments: {} }],
      }),
      request,
    );
    expect(parsed?.assistantText).toBe('starting');
    expect(parsed?.toolCalls[0]?.function.name).toBe('scope_targets');
  });

  it('falls back to text-only on malformed or unknown actions', () => {
    expect(parseStructuredEnvelope('{broken', request)).toBeUndefined();
    expect(
      parseStructuredEnvelope(
        JSON.stringify({
          assistantText: 'no',
          toolCalls: [{ name: 'shell', arguments: { command: 'id' } }],
        }),
        request,
      ),
    ).toBeUndefined();
  });
});

describe('OpenClaude JSON output', () => {
  it('extracts a normal result or structured output', () => {
    expect(parseOpenClaudeOutput(JSON.stringify({ type: 'result', result: '{"ok":true}' }))).toBe(
      '{"ok":true}',
    );
    expect(parseOpenClaudeOutput(JSON.stringify({ structured_output: { ok: true } }))).toBe(
      '{"ok":true}',
    );
  });

  it('surfaces OpenClaude execution errors', () => {
    expect(() =>
      parseOpenClaudeOutput(JSON.stringify({ is_error: true, errors: ['provider unavailable'] })),
    ).toThrow('provider unavailable');
  });
});
