import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../../llm/types.js';
import {
  parseCodexJsonl,
  parseOpenClaudeOutput,
  parseStructuredEnvelope,
  prepareCloudPayload,
} from './cli.js';

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

describe('cloud payload boundary', () => {
  it('redacts credentials before hashing, previewing, and sending the exact prompt', () => {
    const prepared = prepareCloudPayload({
      ...request,
      messages: [
        {
          role: 'user',
          content: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
        },
      ],
    });
    expect(prepared.prompt).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(prepared.preview).toBe(prepared.prompt);
    expect(prepared.redactionCount).toBe(1);
    expect(prepared.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.bytes).toBe(Buffer.byteLength(prepared.prompt));
  });
});

describe('Codex JSONL output', () => {
  it('collects only completed agent messages', () => {
    expect(
      parseCodexJsonl(
        [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: '{"assistantText":"ok","toolCalls":[]}' },
          }),
        ].join('\n'),
      ),
    ).toBe('{"assistantText":"ok","toolCalls":[]}');
  });

  it('fails closed on malformed JSON event output', () => {
    expect(() => parseCodexJsonl('{broken')).toThrow('malformed JSON');
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
