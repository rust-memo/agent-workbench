import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config/config.js';
import { newFromConfig } from './factory.js';

describe('newFromConfig', () => {
  it('creates a Kimi client with Moonshot defaults', () => {
    const cfg = defaultConfig();
    cfg.backend = 'kimi';
    cfg.api_key = 'sk-kimi';

    const client = newFromConfig(cfg);

    expect(client.name()).toBe('kimi');
    expect(client.model()).toBe('kimi-k2.6');
  });

  it('requires a Kimi API key', () => {
    const cfg = defaultConfig();
    cfg.backend = 'kimi';

    expect(() => newFromConfig(cfg)).toThrow(/MOONSHOT_API_KEY/);
  });
});
