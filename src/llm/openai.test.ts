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
        if (body.model === 'glm-stream-leak') {
          send({ choices: [{ delta: { content: 'Hi! ' } }] });
          send({ choices: [{ delta: { content: 'What can I help with?<|us' } }] });
          send({ choices: [{ delta: { content: 'er|>hello hello hello' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        if (body.model === 'glm-observation-leak') {
          send({ choices: [{ delta: { content: 'I will test the target.<|ob' } }] });
          send({
            choices: [
              {
                delta: {
                  content:
                    'servation|><|observation|>I got a 200 OK response and robots.txt was not found.',
                },
              },
            ],
          });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
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
      if (body.model === 'glm-leak') {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Hi! What can I help you with today?<|user|>hello\nhello\nhello',
                },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
      if (body.model === 'glm-observation-leak') {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content:
                    'I will test the target.<|observation|><|observation|>I got a 200 OK response.',
                },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
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

  it('adds LM Studio stop tokens and trims leaked chat-template roles', async () => {
    const c = OpenAIClient.lmStudio(baseURL, 'glm-leak');
    const out = await c.chat({ model: 'glm-leak', messages: [{ role: 'user', content: 'hello' }] });

    expect(out.message.content).toBe('Hi! What can I help you with today?');
    expect(lastBody?.stop).toContain('<|user|>');
    expect(lastBody?.stop).toContain('<|observation|>');
  });

  it('trims leaked LM Studio observation markers in non-streaming responses', async () => {
    const c = OpenAIClient.lmStudio(baseURL, 'glm-observation-leak');
    const out = await c.chat({
      model: 'glm-observation-leak',
      messages: [{ role: 'user', content: 'test target' }],
    });

    expect(out.message.content).toBe('I will test the target.');
    expect(out.message.content).not.toContain('<|observation|>');
  });

  it('withholds split LM Studio role tokens during streaming', async () => {
    const c = OpenAIClient.lmStudio(baseURL, 'glm-stream-leak');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'glm-stream-leak', messages: [{ role: 'user', content: 'hello' }] },
      (d) => deltas.push(d),
    );

    expect(deltas.join('')).toBe('Hi! What can I help with?');
    expect(out.message.content).toBe('Hi! What can I help with?');
    expect(deltas.join('')).not.toContain('<|user|>');
    expect(deltas.join('')).not.toContain('hello hello');
  });

  it('withholds split LM Studio observation markers during streaming', async () => {
    const c = OpenAIClient.lmStudio(baseURL, 'glm-observation-leak');
    const deltas: string[] = [];
    const out = await c.chatStream(
      { model: 'glm-observation-leak', messages: [{ role: 'user', content: 'test target' }] },
      (d) => deltas.push(d),
    );

    expect(deltas.join('')).toBe('I will test the target.');
    expect(out.message.content).toBe('I will test the target.');
    expect(deltas.join('')).not.toContain('<|observation|>');
    expect(deltas.join('')).not.toContain('200 OK');
  });
});
