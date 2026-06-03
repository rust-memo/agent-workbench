// OpenAI-compatible backend. Covers LM Studio, vLLM, llama.cpp server,
// and remote OpenAI-compatible providers.
//
// Streaming is via SSE (data: <json>\n\n ... data: [DONE]).
// Tool calls in the stream arrive as fragmented deltas indexed by
// position; we accumulate them per-index and assign a fallback ID if the
// server omits one.

import type { Client, Pinger, StreamingClient } from './client.js';
import { classifyBackend } from './errors.js';
import { newCallID } from './ids.js';
import type { ChatRequest, ChatResponse, Message, ToolCall } from './types.js';

interface OAIToolCallFragment {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OAIChoiceMessage {
  role: string;
  content?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
}

interface OAIChatResp {
  choices?: Array<{
    message: OAIChoiceMessage;
    finish_reason?: string;
  }>;
  error?: { message: string };
}

interface OAIStreamResp {
  choices?: Array<{
    delta: {
      content?: string;
      tool_calls?: OAIToolCallFragment[];
    };
    finish_reason?: string;
  }>;
}

const LMSTUDIO_STOP_TOKENS = [
  '<|user|>',
  '<|assistant|>',
  '<|system|>',
  '<|observation|>',
  '<|tool|>',
  '<|tool_call|>',
  '<|tool_response|>',
  '<|function|>',
  '<|end|>',
  '<|im_end|>',
  '<|im_start|>',
  '<|endoftext|>',
];

export class OpenAIClient implements Client, StreamingClient, Pinger {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelID: string;
  readonly label: string;

  constructor(baseURL: string, apiKey: string, model: string, label = 'openai-compat') {
    this.baseURL = baseURL;
    this.apiKey = apiKey;
    this.modelID = model;
    this.label = label;
  }

  static lmStudio(baseURL: string, model: string): OpenAIClient {
    // LM Studio ignores auth — pass empty so the Authorization header is
    // omitted entirely (the chat/ping paths already guard on apiKey).
    return new OpenAIClient(baseURL || 'http://localhost:1234/v1', '', model, 'lmstudio');
  }

  name(): string {
    return this.label;
  }

  model(): string {
    return this.modelID;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const resp = await fetch(`${this.baseURL}/models`, { method: 'GET', headers, signal });
    if (resp.status >= 500) {
      throw new Error(`${this.label} status ${resp.status}`);
    }
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = this.encodeRequest(req, false);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw classifyBackend(this.label, err, 0, undefined);
    }
    const raw = await resp.text();
    if (resp.status !== 200) {
      throw classifyBackend(this.label, null, resp.status, raw);
    }
    const out = JSON.parse(raw) as OAIChatResp;
    if (out.error) {
      throw new Error(`${this.label} api error: ${out.error.message}`);
    }
    if (!out.choices?.length) {
      throw new Error(`${this.label}: empty choices`);
    }
    const choice = out.choices[0];
    if (!choice) throw new Error(`${this.label}: empty choices`);
    const msg: Message = {
      role: 'assistant',
      content: this.trimLeakedTemplate(choice.message.content ?? ''),
    };
    if (choice.message.tool_calls?.length) {
      msg.toolCalls = choice.message.tool_calls.map<ToolCall>((tc) => ({
        id: tc.id ?? newCallID(),
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }
    return { message: msg, finishReason: choice.finish_reason ?? '' };
  }

  async chatStream(
    req: ChatRequest,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const body = this.encodeRequest(req, true);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { ...this.headers(), Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw classifyBackend(this.label, err, 0, undefined);
    }
    if (resp.status !== 200) {
      const raw = await resp.text();
      throw classifyBackend(this.label, null, resp.status, raw);
    }
    if (!resp.body) {
      throw new Error(`${this.label}: empty stream body`);
    }

    let rawContent = '';
    let emittedLen = 0;
    let finish = '';
    const parts = new Map<number, { id: string; name: string; args: string }>();
    let stoppedByTemplate = false;

    for await (const line of iterSSE(resp.body)) {
      if (stoppedByTemplate) break;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      let chunk: OAIStreamResp;
      try {
        chunk = JSON.parse(data) as OAIStreamResp;
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      if (choice.delta.content) {
        rawContent += choice.delta.content;
        const view = this.streamingTemplateView(rawContent);
        const emitText = view.visible.slice(emittedLen);
        if (emitText) {
          onDelta(emitText);
          emittedLen += emitText.length;
        }
        if (view.stopped) {
          rawContent = view.visible;
          stoppedByTemplate = true;
          break;
        }
      }
      for (const tc of choice.delta.tool_calls ?? []) {
        const existing = parts.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        parts.set(tc.index, existing);
      }
    }

    const finalContent = this.trimLeakedTemplate(rawContent);
    if (!stoppedByTemplate && finalContent.length > emittedLen) {
      onDelta(finalContent.slice(emittedLen));
    }
    const msg: Message = { role: 'assistant', content: finalContent };
    const indexes = Array.from(parts.keys()).sort((a, b) => a - b);
    if (indexes.length > 0) {
      msg.toolCalls = indexes.map<ToolCall>((i) => {
        const p = parts.get(i);
        if (!p) throw new Error('unreachable');
        return {
          id: p.id || newCallID(),
          type: 'function',
          function: { name: p.name, arguments: p.args },
        };
      });
    }
    return { message: msg, finishReason: finish };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private encodeRequest(req: ChatRequest, stream: boolean) {
    const body: {
      model: string;
      stream: boolean;
      messages: Array<{
        role: string;
        content?: string;
        tool_calls?: unknown[];
        tool_call_id?: string;
        name?: string;
      }>;
      tools?: Array<{
        type: 'function';
        function: {
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        };
      }>;
      thinking?: { type: 'disabled' };
      stop?: string[];
    } = {
      model: this.modelID,
      stream,
      messages: req.messages.map((m) => {
        const out: {
          role: string;
          content?: string;
          tool_calls?: unknown[];
          tool_call_id?: string;
          name?: string;
        } = {
          role: m.role,
          content: m.content,
        };
        if (m.toolCallID) out.tool_call_id = m.toolCallID;
        if (m.name) out.name = m.name;
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        }
        return out;
      }),
      tools: req.tools?.map((t) => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      })),
    };
    if (this.label === 'kimi') {
      body.thinking = { type: 'disabled' };
    }
    if (this.label === 'lmstudio') {
      body.stop = LMSTUDIO_STOP_TOKENS;
    }
    return body;
  }

  private trimLeakedTemplate(content: string): string {
    if (this.label !== 'lmstudio') return content;
    return trimAtFirstStop(content, LMSTUDIO_STOP_TOKENS);
  }

  private streamingTemplateView(raw: string): { visible: string; stopped: boolean } {
    if (this.label !== 'lmstudio') return { visible: raw, stopped: false };
    const idx = firstStopIndex(raw, LMSTUDIO_STOP_TOKENS);
    if (idx >= 0) return { visible: raw.slice(0, idx), stopped: true };
    const hold = longestStopPrefixSuffix(raw, LMSTUDIO_STOP_TOKENS);
    return { visible: hold > 0 ? raw.slice(0, -hold) : raw, stopped: false };
  }
}

function trimAtFirstStop(content: string, stops: readonly string[]): string {
  const idx = firstStopIndex(content, stops);
  return idx >= 0 ? content.slice(0, idx).trimEnd() : content;
}

function firstStopIndex(content: string, stops: readonly string[]): number {
  let best = -1;
  for (const stop of stops) {
    const idx = content.indexOf(stop);
    if (idx >= 0 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function longestStopPrefixSuffix(content: string, stops: readonly string[]): number {
  const max = Math.min(content.length, Math.max(...stops.map((s) => s.length - 1)));
  for (let n = max; n > 0; n--) {
    const suffix = content.slice(-n);
    if (stops.some((stop) => stop.startsWith(suffix))) return n;
  }
  return 0;
}

/**
 * Decode a byte stream into SSE-style logical lines. Splits on `\n\n`
 * (event boundary) and also on `\n` for single-line events. Yields each
 * raw line so the caller can inspect `data:` / `event:` prefixes.
 */
async function* iterSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
      idx = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer.replace(/\r$/, '');
}
