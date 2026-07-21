import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { Client } from '../../llm/client.js';
import { OllamaClient } from '../../llm/ollama.js';
import { clean } from '../scanners/localRunner.js';
import type { ProviderCapabilities, WebProviderId } from '../types.js';
import { OpenCodeCliClient, QwenCliClient } from './cli.js';

export class WebProviderManager {
  readonly qwenPath = process.env.PENTESTERFLOW_QWEN_PATH ?? 'qwen';
  readonly openCodePath =
    process.env.PENTESTERFLOW_OPENCODE_PATH ?? join(homedir(), '.opencode', 'bin', 'opencode');

  constructor(readonly ollamaBaseURL: string) {}

  create(provider: WebProviderId, model: string): Client {
    if (provider === 'ollama') return new OllamaClient(this.ollamaBaseURL, model);
    if (provider === 'qwen') return new QwenCliClient(this.qwenPath, model);
    return new OpenCodeCliClient(this.openCodePath, model);
  }

  async capabilities(): Promise<ProviderCapabilities[]> {
    return Promise.all([
      this.ollamaCapabilities(),
      this.qwenCapabilities(),
      this.openCodeCapabilities(),
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
    return capability('qwen', 'Qwen Code', probe.ready, probe.version, ['default'], {
      error: probe.error,
      streaming: false,
      sandbox: true,
      modelDiscovery: false,
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
          .filter((line) => /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+$/.test(line))
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
    toolDisable: provider === 'opencode',
    modelDiscovery: extra.modelDiscovery,
    externalContextWarning: extra.externalContextWarning,
  };
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
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
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

function errorText(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
