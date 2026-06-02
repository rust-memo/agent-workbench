// Fetch the list of available models from an LLM backend. Used by the
// interactive /provider flow to populate the model picker after the user
// chooses Ollama / LM Studio / openai-compat / Kimi.

import type { Backend } from '../config/config.js';
import { KIMI_DEFAULT_BASE_URL } from './providers.js';

const DEFAULT_TIMEOUT_MS = 5_000;

const DEFAULT_BASE_URL: Record<Exclude<Backend, ''>, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234/v1',
  'openai-compat': '',
  kimi: KIMI_DEFAULT_BASE_URL,
};

/**
 * Query the backend's model-list endpoint and return the IDs. Throws
 * on transport failure or non-2xx. Trips a 5-second timeout so a stalled
 * endpoint doesn't wedge the UI.
 *
 *   ollama        → GET <base>/api/tags  → { models: [{ name }] }
 *   lmstudio      → GET <base>/models    → { data:   [{ id   }] }
 *   openai-compat → GET <base>/models    → same as lmstudio (Bearer header)
 *   kimi          → GET <base>/models    → same as openai-compat (Bearer header)
 */
export async function listModels(
  backend: Backend,
  baseURL = '',
  apiKey = '',
  signal?: AbortSignal,
): Promise<string[]> {
  const b: Exclude<Backend, ''> = backend === '' ? 'ollama' : backend;
  const base = baseURL || DEFAULT_BASE_URL[b];
  if (!base) throw new Error(`${b} backend requires a base URL`);

  const path = b === 'ollama' ? '/api/tags' : '/models';
  const headers: Record<string, string> = {};
  if (apiKey && b !== 'ollama') {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const resp = await fetch(`${base}${path}`, { method: 'GET', headers, signal: ctl.signal });
    if (resp.status !== 200) {
      throw new Error(`${b} list-models returned ${resp.status}`);
    }
    const body = (await resp.json()) as unknown;
    return parseModels(b, body);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function parseModels(backend: Exclude<Backend, ''>, body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  if (backend === 'ollama') {
    const models = (body as { models?: Array<{ name?: unknown }> }).models ?? [];
    return models
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter((n): n is string => n.length > 0);
  }
  const data = (body as { data?: Array<{ id?: unknown }> }).data ?? [];
  return data
    .map((m) => (typeof m.id === 'string' ? m.id : ''))
    .filter((n): n is string => n.length > 0);
}
