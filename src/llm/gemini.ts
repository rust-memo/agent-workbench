import type { Client, Pinger } from './client.js';
import { type BackendError, classifyBackend, parseRetryAfter } from './errors.js';
import { newCallID } from './ids.js';
import { withRetry } from './retry.js';
import type { ChatRequest, ChatResponse, Message, ToolSpec } from './types.js';

/** Annotate a backend error with the server's Retry-After so withRetry can
 *  honor it instead of its computed backoff. */
function withRetryAfter(err: BackendError, resp: Response): BackendError {
  const ms = parseRetryAfter(resp.headers.get('retry-after'));
  if (ms !== undefined) err.retryAfterMs = ms;
  return err;
}

interface GeminiPart {
  text?: string;
  thoughtSignature?: string;
  thought_signature?: string;
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  error?: { message?: string };
}
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

export class GeminiClient implements Client, Pinger {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelID: string;
  private readonly temperature?: number;
  private readonly maxTokens?: number;

  constructor(
    baseURL: string,
    apiKey: string,
    model: string,
    genOpts: { temperature?: number; maxTokens?: number } = {},
  ) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.modelID = model;
    this.temperature = genOpts.temperature;
    this.maxTokens = genOpts.maxTokens;
  }

  name(): string {
    return 'gemini';
  }

  model(): string {
    return this.modelID;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const resp = await fetch(`${this.baseURL}/models`, {
      method: 'GET',
      // Pass the key as a header, not a query param, so it can't leak into
      // access/proxy logs or error messages that echo the request URL.
      headers: { 'x-goog-api-key': this.apiKey },
      signal,
    });
    if (resp.status >= 500) {
      throw new Error(`gemini status ${resp.status}`);
    }
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    // Retry rate limits / transient 5xx with backoff (E7). The call has no
    // observable side effects before it returns, so re-running it is safe.
    return withRetry(() => this.chatOnce(req, signal), { signal });
  }

  private async chatOnce(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = encodeRequest(req, { temperature: this.temperature, maxTokens: this.maxTokens });
    const { signal: combinedSignal, dispose } = withTimeout(signal, CHAT_TIMEOUT_MS);
    try {
      let resp: Response;
      try {
        resp = await fetch(
          `${this.baseURL}/${withModelsPrefix(req.model || this.modelID)}:generateContent`,
          {
            method: 'POST',
            // Key in a header, not the URL query, to keep it out of logs.
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: JSON.stringify(body),
            signal: combinedSignal,
          },
        );
      } catch (err) {
        throw classifyBackend('gemini', err, 0, undefined);
      }
      const raw = await resp.text();
      if (resp.status !== 200) {
        throw withRetryAfter(classifyBackend('gemini', null, resp.status, raw), resp);
      }
      let out: GeminiResponse;
      try {
        out = JSON.parse(raw) as GeminiResponse;
      } catch {
        throw classifyBackend('gemini', null, resp.status, `invalid JSON from gemini: ${raw}`);
      }
      if (out.error?.message) {
        // Route through the classifier so rate-limit phrasing in a 200 body
        // becomes a retryable BackendError rather than a plain Error.
        throw classifyBackend('gemini', null, resp.status, out.error.message);
      }
      const choice = out.candidates?.[0];
      if (!choice) throw new Error('gemini: empty candidates');
      const parts = choice.content?.parts ?? [];
      const text = parts
        .map((p) => p.text ?? '')
        .filter(Boolean)
        .join('');
      const calls = parts.filter((p) => Boolean(p.functionCall?.name));
      const msg: Message = { role: 'assistant', content: text };
      if (calls.length > 0) {
        msg.toolCalls = calls.map((part) => {
          const fc = part.functionCall;
          const thoughtSignature = part.thoughtSignature ?? part.thought_signature;
          return {
            id: newCallID(),
            type: 'function',
            function: {
              name: fc?.name ?? '',
              arguments: JSON.stringify(fc?.args ?? {}),
            },
            ...(thoughtSignature ? { provider: { gemini: { thoughtSignature } } } : {}),
          };
        });
      }
      return { message: msg, finishReason: choice.finishReason ?? '' };
    } finally {
      dispose();
    }
  }
}

/** Build a per-request abort signal that fires when `parent` aborts OR after
 *  `ms`, paired with a `dispose` that clears the timer and detaches the
 *  listener. Replaces AbortSignal.timeout/any, whose 10-minute timers stay
 *  pending until they fire even after the request settles — leaking one timer
 *  per call. Call `dispose()` in a finally once the request is done. */
function withTimeout(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (parent?.aborted) ctl.abort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), ms);
  return {
    signal: ctl.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function encodeRequest(
  req: ChatRequest,
  genOpts: { temperature?: number; maxTokens?: number } = {},
): Record<string, unknown> {
  const systemText = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = req.messages.filter((m) => m.role !== 'system').flatMap((m) => encodeMessage(m));
  const body: Record<string, unknown> = {
    contents,
  };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map(encodeTool) }];
  }
  // Generation knobs. Gemini nests these under generationConfig and names the
  // token cap maxOutputTokens (vs OpenAI's max_tokens). Emit only what's set.
  const generationConfig: Record<string, unknown> = {};
  if (genOpts.temperature !== undefined) generationConfig.temperature = genOpts.temperature;
  if (genOpts.maxTokens !== undefined && genOpts.maxTokens > 0) {
    generationConfig.maxOutputTokens = genOpts.maxTokens;
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  return body;
}

/** Ensure the model id carries the `models/` (or `tunedModels/`) prefix the
 *  v1beta REST path requires, so a bare id from manual config doesn't build a
 *  404 URL (L5). */
function withModelsPrefix(id: string): string {
  if (id.startsWith('models/') || id.startsWith('tunedModels/')) return id;
  return `models/${id}`;
}

function encodeMessage(m: Message): GeminiContent[] {
  if (m.role === 'tool') {
    return [
      {
        // v1beta Content.role accepts only 'user' / 'model'. A functionResponse
        // is delivered as a 'user' turn; the deprecated 'function' role makes
        // newer models 400 on multi-turn tool use (M8).
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name || 'tool_result',
              response: { result: m.content },
            },
          },
        ],
      },
    ];
  }
  if (m.role === 'assistant') {
    const parts: GeminiPart[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const tc of m.toolCalls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      parts.push({
        functionCall: { name: tc.function.name, args },
        ...(tc.provider?.gemini?.thoughtSignature
          ? { thoughtSignature: tc.provider.gemini.thoughtSignature }
          : {}),
      });
    }
    return parts.length > 0 ? [{ role: 'model', parts }] : [];
  }
  return [{ role: 'user', parts: [{ text: m.content }] }];
}

function encodeTool(tool: ToolSpec): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: normalizeSchema(tool.function.parameters),
  };
}

function normalizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase();
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, prop]) => [
          name,
          normalizeSchema(prop),
        ]),
      );
      continue;
    }
    if (key === 'items') {
      out.items = normalizeSchema(value);
      continue;
    }
    if (['additionalProperties', '$schema', 'definitions', '$defs'].includes(key)) continue;
    out[key] = normalizeSchema(value);
  }
  return out;
}
