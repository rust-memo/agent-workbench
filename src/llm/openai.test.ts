// Integration test for the OpenAI-compatible client against a real
// in-process HTTP server. Exercises SSE streaming tool-call accumulation
// (fragments across multiple `data:` events).

import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAIClient } from './openai.js';
import type { ChatRequest } from './types.js';

let server: Server;
let baseURL = '';
let lastBody: Record<string, unknown> | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        stream?: boolean;
      };
      lastBody = body as Record<string, unknown>;

      if (body.stream) {
        // SSE stream that fragments a tool call across two events, with
        // some plain content first.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        send({ choices: [{ delta: { content: 'Working' } }] });
        send({ choices: [{ delta: { content: ' on it' } }] });
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'http', arguments: '{"url":' },
                  },
                ],
              },
            },
          ],
        });
        send({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"https://x.example.com"}' } }],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}/v1`;
});

afterAll(() => {
  server?.close();
});

describe('OpenAIClient', () => {
  it('non-streaming chat returns content', async () => {
    const c = new OpenAIClient(baseURL, '', 'qwen-coder');
    const req: ChatRequest = { model: 'qwen-coder', messages: [{ role: 'user', content: 'hi' }] };
    const out = await c.chat(req);
    expect(out.message.content).toBe('hi');
    expect(out.finishReason).toBe('stop');
  });

  it('streaming reassembles a fragmented tool call across SSE events', async () => {
    const c = new OpenAIClient(baseURL, '', 'qwen-coder');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'qwen-coder', messages: [{ role: 'user', content: 'go' }] },
      (d) => deltas.push(d),
    );
    expect(deltas.join('')).toBe('Working on it');
    expect(out.message.toolCalls).toHaveLength(1);
    expect(out.message.toolCalls?.[0]?.id).toBe('call_abc');
    expect(out.message.toolCalls?.[0]?.function.name).toBe('http');
    expect(out.message.toolCalls?.[0]?.function.arguments).toBe('{"url":"https://x.example.com"}');
    expect(out.finishReason).toBe('tool_calls');
  });

  it('lmStudio factory uses the right default URL', () => {
    const c = OpenAIClient.lmStudio('', 'q');
    expect(c.baseURL).toBe('http://localhost:1234/v1');
    expect(c.name()).toBe('lmstudio');
  });

  it('ping succeeds when the server is up', async () => {
    const c = new OpenAIClient(baseURL, '', 'qwen-coder');
    await expect(c.ping()).resolves.toBeUndefined();
  });

  it('disables Kimi thinking to avoid reasoning_content/tool-call history errors', async () => {
    const c = new OpenAIClient(baseURL, 'sk-kimi', 'kimi-k2.6', 'kimi');
    await c.chat({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] });
    expect(lastBody?.thinking).toEqual({ type: 'disabled' });
  });
});
