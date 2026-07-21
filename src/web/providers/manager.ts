import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { Client } from '../../llm/client.js';
import { OllamaClient } from '../../llm/ollama.js';
import { clean } from '../scanners/localRunner.js';
import type { ProviderCapabilities, WebProviderId } from '../types.js';
import { OpenClaudeCliClient, OpenCodeCliClient, QwenCliClient } from './cli.js';

export class WebProviderManager {
  readonly qwenPath = process.env.PENTESTERFLOW_QWEN_PATH ?? 'qwen';
  readonly openCodePath =
    process.env.PENTESTERFLOW_OPENCODE_PATH ?? join(homedir(), '.opencode', 'bin', 'opencode');
  readonly openClaudePath =
    process.env.PENTESTERFLOW_OPENCLAUDE_PATH ??
    join(homedir(), '.nvm', 'versions', 'node', 'v22.23.1', 'bin', 'openclaude');

  constructor(readonly ollamaBaseURL: string) {}

  create(provider: WebProviderId, model: string): Client {
    if (provider === 'ollama') return new OllamaClient(this.ollamaBaseURL, model);
    if (provider === 'qwen') return new QwenCliClient(this.qwenPath, model);
    if (provider === 'opencode') return new OpenCodeCliClient(this.openCodePath, model);
    return new OpenClaudeCliClient(this.openClaudePath, model);
  }

  async capabilities(): Promise<ProviderCapabilities[]> {
    return Promise.all([
      this.ollamaCapabilities(),
      this.qwenCapabilities(),
      this.openCodeCapabilities(),
      this.openClaudeCapabilities(),
    ]);
  }

  private async ollamaCapabilities(): Promise<ProviderCapabilities> {
    try {
      const response = await fetch(`${this.ollamaBaseURL}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      return capability(
        'ollama',
        'Ollama',
        true,
        'local HTTP',
        (body.models ?? []).flatMap((m) => (m.name ? [m.name] : [])),
        {
          streaming: true,
          sandbox: false,
          modelDiscovery: true,
          externalContextWarning: false,
        },
      );
    } catch (error) {
      return capability('ollama', 'Ollama', false, 'unavailable', [], {
        error: errorText(error),
        streaming: true,
        sandbox: false,
        modelDiscovery: true,
        externalContextWarning: false,
      });
    }
  }

  private async qwenCapabilities(): Promise<ProviderCapabilities> {
    const probe = await command(this.qwenPath, ['--version']);
    let models = ['default'];
    let discoveryError: string | undefined;
    if (probe.ready) {
      try {
        const settingsPath =
          process.env.PENTESTERFLOW_QWEN_SETTINGS ?? join(homedir(), '.qwen', 'settings.json');
        models = modelsFromQwenSettings(JSON.parse(await readFile(settingsPath, 'utf8')));
        if (models.length === 0) models = ['default'];
      } catch (error) {
        discoveryError = `model discovery: ${errorText(error)}`;
      }
    }
    return capability('qwen', 'Qwen Code', probe.ready, probe.version, models, {
      error: probe.error ?? discoveryError,
      streaming: false,
      sandbox: true,
      modelDiscovery: models[0] !== 'default',
      externalContextWarning: true,
    });
  }

  private async openCodeCapabilities(): Promise<ProviderCapabilities> {
    const probe = await command(this.openCodePath, ['--version']);
    let models: string[] = [];
    if (probe.ready) {
      const discovered = await command(this.openCodePath, ['models'], 10_000);
      if (discovered.ready)
        models = discovered.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => isSafeModelId(line) && line.includes('/'))
          .slice(0, 500);
    }
    return capability('opencode', 'OpenCode', probe.ready, probe.version, models, {
      error: probe.error,
      streaming: false,
      sandbox: true,
      modelDiscovery: true,
      externalContextWarning: true,
    });
  }

  private async openClaudeCapabilities(): Promise<ProviderCapabilities> {
    const probe = await command(this.openClaudePath, ['--version']);
    let models = ['default'];
    let discoveryError: string | undefined;
    if (probe.ready) {
      try {
        const settingsPath =
          process.env.PENTESTERFLOW_OPENCLAUDE_SETTINGS ??
          join(homedir(), '.openclaude', 'settings.json');
        const cachePath =
          process.env.PENTESTERFLOW_OPENCLAUDE_MODEL_CACHE ??
          join(homedir(), '.openclaude', 'model-discovery-cache.json');
        const [settings, cache] = await Promise.all([
          readJson(settingsPath),
          readJson(cachePath).catch(() => undefined),
        ]);
        models = modelsFromOpenClaudeConfig(settings, cache);
        if (models.length === 0) models = ['default'];
      } catch (error) {
        discoveryError = `model discovery: ${errorText(error)}`;
      }
    }
    return capability('openclaude', 'OpenClaude', probe.ready, probe.version, models, {
      error: probe.error ?? discoveryError,
      streaming: false,
      sandbox: true,
      modelDiscovery: models[0] !== 'default',
      externalContextWarning: true,
    });
  }
}

function capability(
  provider: WebProviderId,
  label: string,
  ready: boolean,
  version: string,
  models: string[],
  extra: {
    error?: string;
    streaming: boolean;
    sandbox: boolean;
    modelDiscovery: boolean;
    externalContextWarning: boolean;
  },
): ProviderCapabilities {
  return {
    provider,
    label,
    ready,
    version,
    error: extra.error,
    models,
    streaming: extra.streaming,
    structuredOutput: true,
    planMode: true,
    sandbox: extra.sandbox,
    toolDisable: provider === 'opencode' || provider === 'openclaude',
    modelDiscovery: extra.modelDiscovery,
    externalContextWarning: extra.externalContextWarning,
    checkedAt: new Date().toISOString(),
  };
}

export function modelsFromQwenSettings(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const models = new Set<string>();
  const add = (candidate: unknown): void => {
    if (typeof candidate === 'string' && isSafeModelId(candidate)) models.add(candidate);
  };
  if (isRecord(value.model)) add(value.model.name);
  if (isRecord(value.modelProviders)) {
    for (const entries of Object.values(value.modelProviders)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) if (isRecord(entry)) add(entry.id);
    }
  }
  return [...models];
}

export function modelsFromOpenClaudeConfig(settings: unknown, cache?: unknown): string[] {
  const models = new Set<string>();
  const add = (candidate: unknown): void => {
    if (typeof candidate !== 'string') return;
    for (const item of candidate.split(',')) {
      const model = item.trim();
      if (isSafeModelId(model)) models.add(model);
    }
  };
  if (isRecord(settings)) {
    add(settings.model);
    if (isRecord(settings.modelOverrides))
      for (const model of Object.values(settings.modelOverrides)) add(model);
    if (Array.isArray(settings.providerProfiles)) {
      for (const profile of settings.providerProfiles) {
        if (!isRecord(profile)) continue;
        add(profile.model);
        if (Array.isArray(profile.models)) for (const model of profile.models) add(model);
      }
    }
  }
  if (isRecord(cache) && isRecord(cache.entries)) {
    for (const entry of Object.values(cache.entries)) {
      if (!isRecord(entry) || !Array.isArray(entry.models)) continue;
      for (const model of entry.models) {
        if (!isRecord(model)) continue;
        add(model.apiName);
        add(model.id);
      }
    }
  }
  return [...models];
}

function isSafeModelId(value: string): boolean {
  return value.length > 0 && value.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._:@/+\-]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function command(
  binary: string,
  args: string[],
  timeout = 3000,
): Promise<{ ready: boolean; version: string; stdout: string; error?: string }> {
  try {
    const result = await execa(binary, args, {
      reject: false,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      extendEnv: false,
      env: {
        HOME: homedir(),
        PATH: binary.includes('/')
          ? `${join(binary, '..')}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`
          : (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'),
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
      },
    });
    const stdout = clean(result.stdout);
    const stderr = clean(result.stderr);
    return {
      ready: result.exitCode === 0,
      version: stdout.split(/\r?\n/, 1)[0] || 'unknown',
      stdout,
      error: result.exitCode === 0 ? undefined : stderr.slice(0, 1000) || `exit ${result.exitCode}`,
    };
  } catch (error) {
    return { ready: false, version: 'unavailable', stdout: '', error: errorText(error) };
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function errorText(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
