import { z } from 'zod';
import type { Prompter } from '../../permission/permission.js';
import type { Tool } from '../../tools/types.js';
import type { LocalScannerRunner } from '../scanners/localRunner.js';
import { classifyDiscoveredValue, hostInScope, normalizeHost } from '../scope.js';
import type { ArtifactStore } from '../storage/artifacts.js';
import type { WebDatabase } from '../storage/database.js';
import type { ScopeDefinition } from '../types.js';

export interface ReconToolContext {
  engagementId: string;
  sessionId: string;
  turnId(): string | undefined;
  scope(): ScopeDefinition;
}

export class ScopeTargetsTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly artifacts: ArtifactStore,
  ) {}
  name(): string {
    return 'scope_targets';
  }
  description(): string {
    return 'Create a server-owned discovery artifact from exact hosts explicitly listed in scope. Makes no network requests.';
  }
  schema(): Record<string, unknown> {
    return { type: 'object', additionalProperties: false, properties: {} };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(
    args: Record<string, unknown>,
    _signal: AbortSignal,
    _prompter: Prompter,
  ): Promise<string> {
    z.object({}).strict().parse(args);
    const scope = this.context.scope();
    const assets = scope.allowedHosts
      .filter((host) => !host.startsWith('*.'))
      .map((host) => ({
        ...classifyDiscoveredValue(host, scope),
        discoveredBy: 'scope',
      }));
    if (assets.length === 0)
      throw new Error('scope has no exact host; add the root explicitly before active recon');
    const artifact = await this.artifacts.save({
      engagementId: this.context.engagementId,
      sessionId: this.context.sessionId,
      turnId: this.context.turnId(),
      kind: 'scope-targets',
      filename: 'scope-targets.json',
      mediaType: 'application/json',
      body: `${JSON.stringify(assets, null, 2)}\n`,
      metadata: { tool: 'scope_targets', total: assets.length },
    });
    return JSON.stringify({ artifactId: artifact.id, total: assets.length });
  }
}

export class SubfinderTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly runner: LocalScannerRunner,
    private readonly artifacts: ArtifactStore,
  ) {}
  name(): string {
    return 'subfinder';
  }
  description(): string {
    return 'Discover subdomains for one explicitly in-scope root domain. Records out-of-scope discoveries but never authorizes scanning them.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['domain'],
      properties: { domain: { type: 'string', maxLength: 253 } },
    };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(
    args: Record<string, unknown>,
    signal: AbortSignal,
    _prompter: Prompter,
  ): Promise<string> {
    const { domain: rawDomain } = z
      .object({ domain: z.string().min(1).max(253) })
      .strict()
      .parse(args);
    const scope = this.context.scope();
    if (!scope.allowThirdPartyPassiveSources)
      throw new Error('third-party passive sources are disabled for this engagement');
    const domain = normalizeHost(rawDomain);
    const discoveryAllowed = scope.allowedHosts.some(
      (pattern) => normalizeHost(pattern.startsWith('*.') ? pattern.slice(2) : pattern) === domain,
    );
    if (!discoveryAllowed) throw new Error('subfinder domain is outside the approved scope');
    const result = await this.runner.subfinder(domain, scope.limits, signal);
    if (result.exitCode !== 0)
      throw new Error(`subfinder exited ${result.exitCode}: ${result.stderr.slice(0, 1000)}`);
    const assets = [
      ...new Set(
        result.stdout
          .split(/\r?\n/)
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ].map((value) => ({ ...classifyDiscoveredValue(value, scope), discoveredBy: 'subfinder' }));
    const artifact = await this.artifacts.save({
      engagementId: this.context.engagementId,
      sessionId: this.context.sessionId,
      turnId: this.context.turnId(),
      kind: 'discovered-assets',
      filename: 'subfinder-assets.json',
      mediaType: 'application/json',
      body: `${JSON.stringify(assets, null, 2)}\n`,
      metadata: {
        tool: 'subfinder',
        domain,
        total: assets.length,
        inScope: assets.filter((a) => a.inScope).length,
      },
    });
    return JSON.stringify({
      artifactId: artifact.id,
      total: assets.length,
      inScope: assets.filter((a) => a.inScope).length,
      outOfScope: assets.filter((a) => !a.inScope).length,
    });
  }
}

export class HttpxTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly runner: LocalScannerRunner,
    private readonly artifacts: ArtifactStore,
    private readonly database: WebDatabase,
  ) {}
  name(): string {
    return 'httpx';
  }
  description(): string {
    return 'Probe only in-scope targets selected from a server-owned discovery artifact. Redirect following is disabled in v0.2.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['inputArtifactId'],
      properties: {
        inputArtifactId: { type: 'string', format: 'uuid' },
        followRedirects: { type: 'boolean', const: false },
      },
    };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(
    args: Record<string, unknown>,
    signal: AbortSignal,
    _prompter: Prompter,
  ): Promise<string> {
    const parsed = z
      .object({
        inputArtifactId: z.string().uuid(),
        followRedirects: z.literal(false).optional().default(false),
      })
      .strict()
      .parse(args);
    const scope = this.context.scope();
    if (!scope.allowDirectLowImpactRecon)
      throw new Error('direct low-impact recon is disabled for this engagement');
    const source = this.database.getArtifact(parsed.inputArtifactId);
    if (!source || source.sessionId !== this.context.sessionId)
      throw new Error('input artifact was not found in this session');
    const raw = this.artifacts.read(source).toString('utf8');
    let values: unknown;
    try {
      values = JSON.parse(raw);
    } catch {
      throw new Error('input artifact is not valid discovery JSON');
    }
    const targets = z
      .array(
        z
          .object({ host: z.string(), inScope: z.boolean(), activeTestingAllowed: z.boolean() })
          .passthrough(),
      )
      .max(100_000)
      .parse(values)
      .filter(
        (asset) => asset.inScope && asset.activeTestingAllowed && hostInScope(asset.host, scope),
      )
      .slice(0, scope.limits.maxUrlsPerHost)
      .map((asset) => asset.host);
    if (targets.length === 0)
      throw new Error('input artifact contains no targets authorized for active recon');
    const result = await this.runner.httpx(
      targets,
      {
        requestsPerSecond: scope.limits.requestsPerSecond,
        concurrency: scope.limits.concurrency,
        followRedirects: false,
      },
      scope.limits,
      signal,
    );
    if (result.exitCode !== 0)
      throw new Error(`httpx exited ${result.exitCode}: ${result.stderr.slice(0, 1000)}`);
    const observations = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          const url =
            typeof value.url === 'string'
              ? value.url
              : typeof value.input === 'string'
                ? value.input
                : '';
          return { ...value, scope: url ? classifyDiscoveredValue(url, scope) : undefined };
        } catch {
          return { raw: line };
        }
      });
    const artifact = await this.artifacts.save({
      engagementId: this.context.engagementId,
      sessionId: this.context.sessionId,
      turnId: this.context.turnId(),
      kind: 'http-observations',
      filename: 'httpx-results.json',
      mediaType: 'application/json',
      body: `${JSON.stringify(observations, null, 2)}\n`,
      metadata: { tool: 'httpx', targets: targets.length },
    });
    return JSON.stringify({
      artifactId: artifact.id,
      targets: targets.length,
      observations: observations.length,
    });
  }
}
