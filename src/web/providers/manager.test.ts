import { describe, expect, it } from 'vitest';
import { modelsFromOpenClaudeConfig, modelsFromQwenSettings, siblingCliPath } from './manager.js';

describe('Qwen model discovery', () => {
  it('finds the Qwen shim beside the active Node runtime when it is installed there', () => {
    const resolved = siblingCliPath('qwen');
    expect(
      resolved === 'qwen' || resolved.endsWith('/qwen') || resolved.endsWith('\\qwen.cmd'),
    ).toBe(true);
  });

  it('reads the active model and configured provider models without duplicates', () => {
    expect(
      modelsFromQwenSettings({
        model: { name: 'vendor/current-model' },
        modelProviders: {
          openai: [
            { id: 'vendor/current-model', name: 'Current' },
            { id: 'vendor/second-model', name: 'Second' },
          ],
          cloud: [{ id: 'provider/@cf/model', name: 'Cloud model' }],
        },
      }),
    ).toEqual(['vendor/current-model', 'vendor/second-model', 'provider/@cf/model']);
  });

  it('ignores malformed and unsafe model identifiers', () => {
    expect(
      modelsFromQwenSettings({
        modelProviders: { openai: [{ id: '--help' }, { id: 'bad model' }, { id: 42 }] },
      }),
    ).toEqual([]);
  });
});

describe('OpenClaude model discovery', () => {
  it('combines active, profile, override, and cached models', () => {
    expect(
      modelsFromOpenClaudeConfig(
        {
          model: 'vendor/active',
          modelOverrides: { alias: 'vendor/override' },
          providerProfiles: [{ model: 'vendor/one,vendor/two' }],
        },
        {
          entries: {
            cached: { models: [{ id: 'vendor/cached', apiName: 'vendor/cached-api' }] },
          },
        },
      ),
    ).toEqual([
      'vendor/active',
      'vendor/override',
      'vendor/one',
      'vendor/two',
      'vendor/cached-api',
      'vendor/cached',
    ]);
  });
});
