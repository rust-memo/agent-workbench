// Build the right Client from the parsed Config.

import type { Config } from '../config/config.js';
import type { Client } from './client.js';
import { OllamaClient } from './ollama.js';
import { OpenAIClient } from './openai.js';
import { KIMI_DEFAULT_BASE_URL, KIMI_DEFAULT_MODEL } from './providers.js';

export function newFromConfig(cfg: Config): Client {
  switch (cfg.backend) {
    case 'ollama':
    case '':
      return new OllamaClient(cfg.base_url, cfg.model);
    case 'lmstudio':
      return OpenAIClient.lmStudio(cfg.base_url, cfg.model);
    case 'openai-compat':
      if (!cfg.base_url) {
        throw new Error('openai-compat backend requires base_url');
      }
      return new OpenAIClient(cfg.base_url, cfg.api_key, cfg.model, 'openai-compat');
    case 'kimi':
      if (!cfg.api_key) {
        throw new Error('kimi backend requires api_key or MOONSHOT_API_KEY');
      }
      return new OpenAIClient(
        cfg.base_url || KIMI_DEFAULT_BASE_URL,
        cfg.api_key,
        cfg.model || KIMI_DEFAULT_MODEL,
        'kimi',
      );
    default: {
      const _exhaustive: never = cfg.backend;
      throw new Error(`unknown backend: ${String(_exhaustive)}`);
    }
  }
}
