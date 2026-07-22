import { describe, expect, it } from 'vitest';
import {
  modelsFromClaudeConfig,
  modelsFromCodexConfig,
  modelsFromOpenClaudeConfig,
  modelsFromQwenSettings,
  siblingCliPath,
} from './manager.js';

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

  it('accepts current and compatibility Qwen model fields', () => {
    expect(
      modelsFromQwenSettings({
        model: 'vendor/string-active',
        modelProviders: {
          openai: [
            { id: 'vendor/id' },
            { model: 'vendor/model-field' },
            { name: 'vendor/name-field' },
          ],
        },
      }),
    ).toEqual(['vendor/string-active', 'vendor/id', 'vendor/model-field', 'vendor/name-field']);
  });

  it('ignores malformed and unsafe model identifiers', () => {
    expect(
      modelsFromQwenSettings({
        modelProviders: { openai: [{ id: '--help' }, { id: 'bad model' }, { id: 42 }] },
      }),
    ).toEqual([]);
  });
});

describe('Codex model discovery', () => {
  it('prioritizes the active model and adds visible cached models', () => {
    expect(
      modelsFromCodexConfig('model = "gpt-active"', {
        models: [
          { slug: 'gpt-active', visibility: 'list' },
          { slug: 'gpt-other', visibility: 'list' },
          { slug: 'gpt-hidden', visibility: 'hide' },
        ],
      }),
    ).toEqual(['gpt-active', 'gpt-other']);
  });
});

describe('Claude model discovery', () => {
  it('accepts safe configured model names', () => {
    expect(
      modelsFromClaudeConfig({
        model: 'claude-sonnet-4',
        env: { ANTHROPIC_MODEL: 'vendor/model' },
      }),
    ).toEqual(['claude-sonnet-4', 'vendor/model']);
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
