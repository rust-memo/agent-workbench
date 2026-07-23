import { z } from 'zod';
import type { Prompter } from '../../permission/permission.js';
import type { Tool } from '../../tools/types.js';
import type { ActionService } from '../actions/service.js';
import type { DockerScannerRunner } from '../scanners/dockerRunner.js';
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
    private readonly runner: DockerScannerRunner,
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
    const rawArtifact = await this.artifacts.save({
      engagementId: this.context.engagementId,
      sessionId: this.context.sessionId,
      turnId: this.context.turnId(),
      kind: 'discovered-assets-raw',
      filename: 'subfinder-raw.txt',
      mediaType: 'text/plain; charset=utf-8',
      body: result.stdout ? `${result.stdout.replace(/\s+$/, '')}\n` : '',
      metadata: {
        tool: 'subfinder',
        domain,
        exitCode: result.exitCode,
        termination: result.termination,
        partial: result.exitCode !== 0,
      },
    });
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
        rawArtifactId: rawArtifact.id,
        exitCode: result.exitCode,
        partial: result.exitCode !== 0,
        total: assets.length,
        inScope: assets.filter((a) => a.inScope).length,
      },
    });
    if (result.exitCode !== 0)
      throw new Error(
        `subfinder exited ${result.exitCode}; partial artifacts ${rawArtifact.id} and ${artifact.id} were saved: ${result.stderr.slice(0, 1000)}`,
      );
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
    private readonly runner: DockerScannerRunner,
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
      metadata: {
        tool: 'httpx',
        targets: targets.length,
        exitCode: result.exitCode,
        termination: result.termination,
        partial: result.exitCode !== 0,
        stderr: result.exitCode === 0 ? undefined : result.stderr.slice(0, 20_000),
      },
    });
    if (result.exitCode !== 0)
      throw new Error(
        `httpx exited ${result.exitCode}; partial artifact ${artifact.id} was saved: ${result.stderr.slice(0, 1000)}`,
      );
    return JSON.stringify({
      artifactId: artifact.id,
      targets: targets.length,
      observations: observations.length,
    });
  }
}

export class DnsxTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly runner: DockerScannerRunner,
    private readonly artifacts: ArtifactStore,
    private readonly database: WebDatabase,
  ) {}
  name(): string {
    return 'dnsx';
  }
  description(): string {
    return 'Resolve only active-testing-authorized hosts from a server-owned discovery artifact using the isolated Docker scanner.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['inputArtifactId'],
      properties: { inputArtifactId: { type: 'string', format: 'uuid' } },
    };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const { inputArtifactId } = z
      .object({ inputArtifactId: z.string().uuid() })
      .strict()
      .parse(args);
    const scope = this.context.scope();
    if (!scope.allowDirectLowImpactRecon)
      throw new Error('direct low-impact recon is disabled for this engagement');
    const source = this.database.getArtifact(inputArtifactId);
    if (!source || source.sessionId !== this.context.sessionId)
      throw new Error('input artifact was not found in this session');
    let values: unknown;
    try {
      values = JSON.parse(this.artifacts.read(source).toString('utf8'));
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
    if (!targets.length)
      throw new Error('input artifact contains no hosts authorized for DNS recon');
    const result = await this.runner.dnsx(targets, scope.limits, signal);
    const rows = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const artifact = await this.artifacts.save({
      engagementId: this.context.engagementId,
      sessionId: this.context.sessionId,
      turnId: this.context.turnId(),
      kind: 'dns-observations',
      filename: 'dnsx-results.json',
      mediaType: 'application/json',
      body: `${JSON.stringify(rows, null, 2)}\n`,
      metadata: {
        tool: 'dnsx',
        targets: targets.length,
        scannerIsolation: 'docker',
        exitCode: result.exitCode,
        termination: result.termination,
        partial: result.exitCode !== 0,
        stderr: result.exitCode === 0 ? undefined : result.stderr.slice(0, 20_000),
      },
    });
    for (const host of targets) {
      this.database.upsertCoverage({
        engagementId: this.context.engagementId,
        sessionId: this.context.sessionId,
        asset: host,
        endpoint: `DNS ${host}`,
        parameter: 'A/AAAA',
        vulnerabilityClass: 'dns-resolution',
        status: 'tried',
        source: 'dnsx',
      });
    }
    if (result.exitCode !== 0)
      throw new Error(
        `dnsx exited ${result.exitCode}; partial artifact ${artifact.id} was saved: ${result.stderr.slice(0, 1000)}`,
      );
    return JSON.stringify({
      artifactId: artifact.id,
      targets: targets.length,
      observations: rows.length,
    });
  }
}

export class KatanaProposalTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly actions: ActionService,
  ) {}
  name(): string {
    return 'katana';
  }
  description(): string {
    return 'Propose an approval-gated, scoped Katana crawl. This tool never executes the crawler itself.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['inputArtifactId', 'reason'],
      properties: {
        inputArtifactId: { type: 'string', format: 'uuid' },
        depth: { type: 'integer', minimum: 1, maximum: 3, default: 2 },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
    };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(args: Record<string, unknown>): Promise<string> {
    const parsed = z
      .object({
        inputArtifactId: z.string().uuid(),
        depth: z.number().int().min(1).max(3).default(2),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(args);
    const scope = this.context.scope();
    const proposal = this.actions.propose({
      engagementId: this.context.engagementId,
      sessionId: this.context.sessionId,
      turnId: this.context.turnId(),
      action: 'katana',
      arguments: { inputArtifactId: parsed.inputArtifactId, depth: parsed.depth },
      reason: parsed.reason,
      scopeVersion: scope.version,
      mode: 'RECON',
    });
    return JSON.stringify({
      proposalId: proposal.id,
      status: proposal.status,
      risk: proposal.risk,
      expiresAt: proposal.expiresAt,
      approvalRequired: true,
    });
  }
}

export class NucleiProposalTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly actions: ActionService,
  ) {}
  name(): string {
    return 'nuclei';
  }
  description(): string {
    return 'Propose an approval-gated Nuclei scan using only the pinned safe HTTP template set. Scanner hits are never auto-confirmed.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['inputArtifactId', 'reason'],
      properties: {
        inputArtifactId: { type: 'string', format: 'uuid' },
        severities: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          items: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
        },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
    };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(args: Record<string, unknown>): Promise<string> {
    const parsed = z
      .object({
        inputArtifactId: z.string().uuid(),
        severities: z
          .array(z.enum(['info', 'low', 'medium', 'high', 'critical']))
          .min(1)
          .max(5)
          .default(['low', 'medium', 'high', 'critical']),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(args);
    const scope = this.context.scope();
    const proposal = this.actions.propose({
      engagementId: this.context.engagementId,
      sessionId: this.context.sessionId,
      turnId: this.context.turnId(),
      action: 'nuclei',
      arguments: {
        inputArtifactId: parsed.inputArtifactId,
        severities: [...new Set(parsed.severities)],
      },
      reason: parsed.reason,
      scopeVersion: scope.version,
      mode: 'RECON',
    });
    return JSON.stringify({
      proposalId: proposal.id,
      status: proposal.status,
      risk: proposal.risk,
      expiresAt: proposal.expiresAt,
      approvalRequired: true,
    });
  }
}

export class FfufProposalTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly actions: ActionService,
  ) {}
  name(): string {
    return 'ffuf';
  }
  description(): string {
    return 'Propose approval-gated FFUF content discovery using the fixed built-in wordlist, scope limits, and no arbitrary request templates.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['inputArtifactId', 'reason'],
      properties: {
        inputArtifactId: { type: 'string', format: 'uuid' },
        matchCodes: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: { type: 'integer', minimum: 100, maximum: 599 },
          default: [200, 204, 301, 302, 307, 401, 403],
        },
        maxTargets: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
    };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(args: Record<string, unknown>): Promise<string> {
    const parsed = z
      .object({
        inputArtifactId: z.string().uuid(),
        matchCodes: z
          .array(z.number().int().min(100).max(599))
          .min(1)
          .max(20)
          .default([200, 204, 301, 302, 307, 401, 403]),
        maxTargets: z.number().int().min(1).max(3).default(1),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(args);
    return proposalResult(
      this.actions.propose({
        engagementId: this.context.engagementId,
        sessionId: this.context.sessionId,
        turnId: this.context.turnId(),
        action: 'ffuf',
        arguments: {
          inputArtifactId: parsed.inputArtifactId,
          matchCodes: [...new Set(parsed.matchCodes)].sort((a, b) => a - b),
          maxTargets: parsed.maxTargets,
        },
        reason: parsed.reason,
        scopeVersion: this.context.scope().version,
        mode: 'RECON',
      }),
    );
  }
}

export class NmapProposalTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly actions: ActionService,
    private readonly raw: boolean,
  ) {}
  name(): string {
    return this.raw ? 'nmap_raw' : 'nmap_connect';
  }
  description(): string {
    return this.raw
      ? 'Propose a separately isolated Nmap SYN scan. Requires the opt-in raw profile, NET_RAW only, and explicit high-risk approval.'
      : 'Propose a non-raw Nmap TCP connect scan with a bounded explicit port list and high-risk approval.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['inputArtifactId', 'ports', 'reason'],
      properties: {
        inputArtifactId: { type: 'string', format: 'uuid' },
        ports: {
          type: 'array',
          minItems: 1,
          maxItems: 128,
          uniqueItems: true,
          items: { type: 'integer', minimum: 1, maximum: 65535 },
        },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
    };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(args: Record<string, unknown>): Promise<string> {
    if (this.raw && !this.actions.rawProfileAvailable())
      throw new Error(
        'raw Nmap profile is disabled; the operator must restart the server with AGENT_WORKBENCH_ENABLE_RAW_SCANNER=1',
      );
    const parsed = z
      .object({
        inputArtifactId: z.string().uuid(),
        ports: z.array(z.number().int().min(1).max(65535)).min(1).max(128),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(args);
    return proposalResult(
      this.actions.propose({
        engagementId: this.context.engagementId,
        sessionId: this.context.sessionId,
        turnId: this.context.turnId(),
        action: this.raw ? 'nmap_raw' : 'nmap_connect',
        arguments: {
          inputArtifactId: parsed.inputArtifactId,
          ports: [...new Set(parsed.ports)].sort((a, b) => a - b),
        },
        reason: parsed.reason,
        scopeVersion: this.context.scope().version,
        mode: 'RECON',
      }),
    );
  }
}

export class HttpValidationProposalTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly actions: ActionService,
  ) {}
  name(): string {
    return 'validate_http';
  }
  description(): string {
    return 'Propose a deterministic, no-redirect GET/HEAD reproduction request for an existing scanner finding. Evidence is saved but never auto-confirms the finding.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['findingId', 'reason'],
      properties: {
        findingId: { type: 'string', format: 'uuid' },
        method: { type: 'string', enum: ['GET', 'HEAD'], default: 'GET' },
        expectedStatus: { type: 'integer', minimum: 100, maximum: 599 },
        bodyContains: { type: 'string', minLength: 1, maxLength: 200 },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
    };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(args: Record<string, unknown>): Promise<string> {
    const parsed = z
      .object({
        findingId: z.string().uuid(),
        method: z.enum(['GET', 'HEAD']).default('GET'),
        expectedStatus: z.number().int().min(100).max(599).optional(),
        bodyContains: z.string().min(1).max(200).optional(),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(args);
    return proposalResult(
      this.actions.propose({
        engagementId: this.context.engagementId,
        sessionId: this.context.sessionId,
        turnId: this.context.turnId(),
        action: 'validate_http',
        arguments: {
          findingId: parsed.findingId,
          method: parsed.method,
          expectedStatus: parsed.expectedStatus,
          bodyContains: parsed.bodyContains,
        },
        reason: parsed.reason,
        scopeVersion: this.context.scope().version,
        mode: 'RECON',
      }),
    );
  }
}

function proposalResult(proposal: import('../types.js').ActionProposalRecord): string {
  return JSON.stringify({
    proposalId: proposal.id,
    status: proposal.status,
    risk: proposal.risk,
    expiresAt: proposal.expiresAt,
    approvalRequired: true,
  });
}

export class WebCoverageTool implements Tool {
  constructor(
    private readonly context: ReconToolContext,
    private readonly database: WebDatabase,
  ) {}
  name(): string {
    return 'coverage';
  }
  description(): string {
    return 'Read the persistent Web coverage summary or list; scanner actions update it automatically.';
  }
  schema(): Record<string, unknown> {
    return {
      type: 'object',
      additionalProperties: false,
      properties: { action: { type: 'string', enum: ['summary', 'list'], default: 'summary' } },
    };
  }
  requiresPermission(): boolean {
    return false;
  }
  async run(args: Record<string, unknown>): Promise<string> {
    const { action } = z
      .object({ action: z.enum(['summary', 'list']).default('summary') })
      .strict()
      .parse(args);
    return JSON.stringify(
      action === 'list'
        ? this.database.listCoverage(this.context.sessionId).slice(0, 500)
        : this.database.coverageSummary(this.context.sessionId),
    );
  }
}
