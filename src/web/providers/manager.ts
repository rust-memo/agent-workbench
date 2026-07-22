import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import type { Client } from '../../llm/client.js';
import { OllamaClient } from '../../llm/ollama.js';
import { clean } from '../scanners/localRunner.js';
import type { ProviderCapabilities, WebProviderId } from '../types.js';
import {
  ClaudeCliClient,
  type CloudPayloadHandler,
  CodexCliClient,
  OpenClaudeCliClient,
  OpenCodeCliClient,
  QwenCliClient,
} from './cli.js';

export class WebProviderManager {
  readonly qwenPath = process.env.PENTESTERFLOW_QWEN_PATH ?? siblingCliPath('qwen');
  readonly codexPath = process.env.PENTESTERFLOW_CODEX_PATH ?? siblingCliPath('codex');
  readonly claudePath = process.env.PENTESTERFLOW_CLAUDE_PATH ?? preferredClaudePath();
  readonly openCodePath =
    process.env.PENTESTERFLOW_OPENCODE_PATH ?? join(homedir(), '.opencode', 'bin', 'opencode');
  readonly openClaudePath =
    process.env.PENTESTERFLOW_OPENCLAUDE_PATH ??
    join(homedir(), '.nvm', 'versions', 'node', 'v22.23.1', 'bin', 'openclaude');

  constructor(readonly ollamaBaseURL: string) {}

  create(provider: WebProviderId, model: string, onPayload?: CloudPayloadHandler): Client {
    if (provider === 'ollama') return new OllamaClient(this.ollamaBaseURL, model);
    if (provider === 'qwen') return new QwenCliClient(this.qwenPath, model, onPayload);
    if (provider === 'codex') return new CodexCliClient(this.codexPath, model, onPayload);
    if (provider === 'claude') return new ClaudeCliClient(this.claudePath, model, onPayload);
    if (provider === 'opencode') return new OpenCodeCliClient(this.openCodePath, model, onPayload);
    return new OpenClaudeCliClient(this.openClaudePath, model, onPayload);
  }

  async capabilities(): Promise<ProviderCapabilities[]> {
    return Promise.all([
      this.ollamaCapabilities(),
      this.qwenCapabilities(),
      this.codexCapabilities(),
      this.claudeCapabilities(),
      this.openCodeCapabilities(),
      this.openClaudeCapabilities(),
    ]);
  }

  private async codexCapabilities(): Promise<ProviderCapabilities> {
    const probe = await command(this.codexPath, ['--version']);
    let models = ['default'];
    let discoveryError: string | undefined;
    if (probe.ready) {
      try {
        const configPath =
          process.env.PENTESTERFLOW_CODEX_CONFIG ?? join(homedir(), '.codex', 'config.toml');
        const cachePath =
          process.env.PENTESTERFLOW_CODEX_MODEL_CACHE ??
          join(homedir(), '.codex', 'models_cache.json');
        const [config, cache] = await Promise.all([
          readFile(configPath, 'utf8').catch(() => ''),
          readJson(cachePath).catch(() => undefined),
        ]);
        models = modelsFromCodexConfig(config, cache);
        if (models.length === 0) models = ['default'];
      } catch (error) {
        discoveryError = `model discovery: ${errorText(error)}`;
      }
    }
    return capability('codex', 'Codex CLI', probe.ready, probe.version, models, {
      error: probe.error ?? discoveryError,
      streaming: true,
      sandbox: true,
      modelDiscovery: models[0] !== 'default',
      externalContextWarning: true,
    });
  }

  private async claudeCapabilities(): Promise<ProviderCapabilities> {
    const probe = await command(this.claudePath, ['--version']);
    let models = ['default', 'sonnet', 'opus', 'haiku'];
    let discoveryError: string | undefined;
    if (probe.ready) {
      try {
        if (/openclaude(?:\.cmd)?$/i.test(this.claudePath)) {
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
          models = uniqueModels(['default', ...modelsFromOpenClaudeConfig(settings, cache)]);
        } else {
          const settingsPath =
            process.env.PENTESTERFLOW_CLAUDE_SETTINGS ??
            join(homedir(), '.claude', 'settings.json');
          const settings = await readJson(settingsPath).catch(() => undefined);
          const configured = modelsFromClaudeConfig(settings);
          models = uniqueModels(['default', ...configured, 'sonnet', 'opus', 'haiku']);
        }
      } catch (error) {
        discoveryError = `model discovery: ${errorText(error)}`;
      }
    }
    return capability('claude', 'Claude CLI', probe.ready, probe.version, models, {
      error: probe.error ?? discoveryError,
      streaming: false,
      sandbox: true,
      modelDiscovery: models.length > 1,
      externalContextWarning: true,
    });
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
    // Qwen's launcher may need to spin up its Node runtime before printing the
    // version. A three-second health timeout was too aggressive on a busy host
    // and Execa reports those timeouts with an undefined exitCode.
    const probe = await command(this.qwenPath, ['--version'], 10_000);
    let models = ['default'];
    let discoveryError: string | undefined;
    try {
      const settingsPath =
        process.env.PENTESTERFLOW_QWEN_SETTINGS ?? join(homedir(), '.qwen', 'settings.json');
      models = modelsFromQwenSettings(JSON.parse(await readFile(settingsPath, 'utf8')));
      if (models.length === 0) models = ['default'];
    } catch (error) {
      discoveryError = `model discovery: ${errorText(error)}`;
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
    toolDisable: provider !== 'ollama' && provider !== 'codex',
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
  if (typeof value.model === 'string') add(value.model);
  if (isRecord(value.model)) {
    add(value.model.id);
    add(value.model.name);
  }
  if (isRecord(value.modelProviders)) {
    for (const entries of Object.values(value.modelProviders)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        // `id` is the current Qwen Code schema. Accept `model` and `name` as
        // compatibility fields used by older/provider-specific settings.
        add(entry.id ?? entry.model ?? entry.name);
      }
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

export function modelsFromCodexConfig(config: string, cache?: unknown): string[] {
  const models = new Set<string>();
  const active = config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1];
  if (active && isSafeModelId(active)) models.add(active);
  if (isRecord(cache) && Array.isArray(cache.models)) {
    for (const item of cache.models) {
      if (!isRecord(item) || item.visibility === 'hide') continue;
      const slug = item.slug;
      if (typeof slug === 'string' && isSafeModelId(slug)) models.add(slug);
    }
  }
  return [...models];
}

export function modelsFromClaudeConfig(settings: unknown): string[] {
  if (!isRecord(settings)) return [];
  const candidates = [settings.model];
  if (isRecord(settings.env)) candidates.push(settings.env.ANTHROPIC_MODEL);
  return uniqueModels(candidates.filter((value): value is string => typeof value === 'string'));
}

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.filter(isSafeModelId))];
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
          ? `${dirname(binary)}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`
          : (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'),
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
      },
    });
    const stdout = clean(result.stdout);
    const stderr = clean(result.stderr);
    if (result.timedOut)
      return {
        ready: false,
        version: 'unavailable',
        stdout,
        error: `CLI health check timed out after ${timeout}ms`,
      };
    if (result.signal)
      return {
        ready: false,
        version: 'unavailable',
        stdout,
        error: `CLI terminated by ${result.signal}${stderr ? `: ${stderr.slice(0, 900)}` : ''}`,
      };
    const exitCode = result.exitCode;
    return {
      ready: exitCode === 0,
      version: stdout.split(/\r?\n/, 1)[0] || 'unknown',
      stdout,
      error:
        exitCode === 0
          ? undefined
          : stderr.slice(0, 1000) ||
            (typeof exitCode === 'number' ? `CLI exited ${exitCode}` : 'CLI stopped unexpectedly'),
    };
  } catch (error) {
    return { ready: false, version: 'unavailable', stdout: '', error: errorText(error) };
  }
}

/** Prefer a CLI installed beside the Node executable that launched the Web
 * server. This makes NVM installs work even when the parent shell did not put
 * that NVM bin directory on PATH. An explicit environment override still wins.
 */
export function siblingCliPath(name: string): string {
  const filename = process.platform === 'win32' ? `${name}.cmd` : name;
  const candidate = join(dirname(process.execPath), filename);
  return existsSync(candidate) ? candidate : name;
}

export function preferredClaudePath(): string {
  const official = siblingCliPath('claude');
  if (official.includes('/') || existsSync(official)) return official;
  const openClaude = siblingCliPath('openclaude');
  if (openClaude.includes('/') || existsSync(openClaude)) return openClaude;
  const legacy = join(homedir(), '.nvm', 'versions', 'node', 'v22.23.1', 'bin', 'openclaude');
  return existsSync(legacy) ? legacy : official;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function errorText(error: unknown): string {
  if (isRecord(error)) {
    if (error.code === 'ENOENT') return 'CLI executable was not found';
    if (error.timedOut === true) return 'CLI health check timed out';
    if (typeof error.signal === 'string') return `CLI terminated by ${error.signal}`;
    if (typeof error.exitCode === 'number') {
      const stderr = typeof error.stderr === 'string' ? clean(error.stderr).trim() : '';
      return `CLI exited ${error.exitCode}${stderr ? `: ${stderr}` : ''}`.slice(0, 1000);
    }
    if (typeof error.shortMessage === 'string') return clean(error.shortMessage).slice(0, 1000);
  }
  const message = clean(error instanceof Error ? error.message : String(error));
  return message
    .replace(/exit(?:ed with code)? undefined/gi, 'without an exit code')
    .slice(0, 1000);
}
