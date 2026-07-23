import { hostInScope, normalizeHost } from '../scope.js';
import type { ReconAssetType, ScopeDefinition } from '../types.js';

export type ReconOutputFormat = 'lines' | 'json' | 'jsonl';

export interface ParsedReconOutput {
  values: Array<{ value: string; type?: ReconAssetType }>;
  malformed: number;
}

export interface ReconToolDefinition<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  executable: string;
  actionName: string;
  argumentBuilder: (input: TInput, scope: ScopeDefinition) => string[];
  outputFormat: ReconOutputFormat;
  parser: (output: string) => ParsedReconOutput;
  artifactDestination: string;
  timeoutSeconds: number;
  maximumOutputBytes: number;
  risk: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  automaticExecutionAllowed: boolean;
  scopePolicy: 'passive-root-only' | 'in-scope-active-only' | 'proposal-only';
  scopeValidator: (input: TInput, scope: ScopeDefinition) => boolean;
  shell: false;
}

/**
 * Server-owned registry for built-in and trusted custom recon definitions.
 * There is deliberately no HTTP/model API for registering a definition.
 */
export class ReconToolRegistry {
  private readonly definitions = new Map<string, ReconToolDefinition>();

  constructor(definitions: ReconToolDefinition[] = BUILT_IN_RECON_TOOLS) {
    for (const definition of definitions) this.registerTrusted(definition);
  }

  registerTrusted(definition: ReconToolDefinition): void {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(definition.name))
      throw new Error('invalid trusted recon tool name');
    if (!definition.executable || /[\0\r\n]/.test(definition.executable))
      throw new Error('invalid trusted recon executable');
    if (definition.shell !== false) throw new Error('trusted recon tools must use shell: false');
    if (this.definitions.has(definition.name))
      throw new Error(`trusted recon tool already registered: ${definition.name}`);
    this.definitions.set(definition.name, Object.freeze({ ...definition }));
  }

  get(name: string): ReconToolDefinition | undefined {
    return this.definitions.get(name);
  }

  list(): ReconToolDefinition[] {
    return [...this.definitions.values()];
  }
}

const lineParser = (output: string): ParsedReconOutput => ({
  values: output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => ({ value })),
  malformed: 0,
});

const BUILT_IN_RECON_TOOLS: ReconToolDefinition[] = [
  {
    name: 'subfinder',
    executable: 'subfinder',
    actionName: 'passive_subdomains',
    argumentBuilder: (input) => ['-silent', '-duc', '-d', String(input.domain)],
    outputFormat: 'lines',
    parser: lineParser,
    artifactDestination: 'subfinder',
    timeoutSeconds: 300,
    maximumOutputBytes: 10 * 1024 * 1024,
    risk: 'low',
    requiresApproval: false,
    automaticExecutionAllowed: true,
    scopePolicy: 'passive-root-only',
    scopeValidator: (input, scope) =>
      typeof input.domain === 'string' &&
      scope.allowedHosts.some(
        (host) => normalizeHost(host.replace(/^\*\./, '')) === normalizeHost(String(input.domain)),
      ),
    shell: false,
  },
  {
    name: 'crtsh',
    executable: 'curl',
    actionName: 'certificate_transparency',
    argumentBuilder: (input) => [
      '--silent',
      '--proto',
      '=https',
      `https://crt.sh/?q=${encodeURIComponent(`%.${String(input.domain)}`)}&output=json`,
    ],
    outputFormat: 'json',
    parser: () => ({ values: [], malformed: 0 }),
    artifactDestination: 'crtsh',
    timeoutSeconds: 60,
    maximumOutputBytes: 10 * 1024 * 1024,
    risk: 'low',
    requiresApproval: false,
    automaticExecutionAllowed: true,
    scopePolicy: 'passive-root-only',
    scopeValidator: (input, scope) =>
      typeof input.domain === 'string' &&
      scope.allowedHosts.some(
        (host) => normalizeHost(host.replace(/^\*\./, '')) === normalizeHost(String(input.domain)),
      ),
    shell: false,
  },
  {
    name: 'dnsx',
    executable: 'dnsx',
    actionName: 'dns_resolution',
    argumentBuilder: (_input, scope) => [
      '-silent',
      '-json',
      '-threads',
      String(scope.limits.concurrency),
    ],
    outputFormat: 'jsonl',
    parser: () => ({ values: [], malformed: 0 }),
    artifactDestination: 'dnsx',
    timeoutSeconds: 300,
    maximumOutputBytes: 10 * 1024 * 1024,
    risk: 'low',
    requiresApproval: false,
    automaticExecutionAllowed: true,
    scopePolicy: 'in-scope-active-only',
    scopeValidator: (input, scope) =>
      Array.isArray(input.targets) &&
      input.targets.every((target) => typeof target === 'string' && hostInScope(target, scope)),
    shell: false,
  },
  {
    name: 'httpx',
    executable: 'httpx',
    actionName: 'http_probe',
    argumentBuilder: (_input, scope) => [
      '-silent',
      '-json',
      '-threads',
      String(scope.limits.concurrency),
    ],
    outputFormat: 'jsonl',
    parser: () => ({ values: [], malformed: 0 }),
    artifactDestination: 'httpx',
    timeoutSeconds: 300,
    maximumOutputBytes: 10 * 1024 * 1024,
    risk: 'low',
    requiresApproval: false,
    automaticExecutionAllowed: true,
    scopePolicy: 'in-scope-active-only',
    scopeValidator: (input, scope) =>
      Array.isArray(input.targets) &&
      input.targets.every((target) => {
        if (typeof target !== 'string') return false;
        try {
          return hostInScope(new URL(target).hostname, scope);
        } catch {
          return hostInScope(target, scope);
        }
      }),
    shell: false,
  },
  {
    name: 'katana',
    executable: 'katana',
    actionName: 'crawl',
    argumentBuilder: (input) => ['-silent', '-jsonl', '-depth', String(input.depth ?? 1)],
    outputFormat: 'jsonl',
    parser: () => ({ values: [], malformed: 0 }),
    artifactDestination: 'katana',
    timeoutSeconds: 300,
    maximumOutputBytes: 10 * 1024 * 1024,
    risk: 'medium',
    requiresApproval: true,
    automaticExecutionAllowed: false,
    scopePolicy: 'proposal-only',
    scopeValidator: () => false,
    shell: false,
  },
];
