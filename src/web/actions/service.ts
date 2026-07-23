import { z } from 'zod';
import type { EventHub } from '../events.js';
import type { DockerScannerRunner } from '../scanners/dockerRunner.js';
import { clean } from '../scanners/output.js';
import { classifyDiscoveredValue, hostInScope } from '../scope.js';
import type { ArtifactStore } from '../storage/artifacts.js';
import type { WebDatabase } from '../storage/database.js';
import type {
  ActionProposalRecord,
  FindingSeverity,
  ScopeDefinition,
  WebActionName,
  WebMode,
} from '../types.js';
import { actionApprovalHash } from './canonical.js';

const inputArtifactSchema = z.object({ inputArtifactId: z.string().uuid() }).strict();
const katanaArgumentsSchema = inputArtifactSchema
  .extend({ depth: z.number().int().min(1).max(3) })
  .strict();
const severitySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
const nucleiArgumentsSchema = inputArtifactSchema
  .extend({ severities: z.array(severitySchema).min(1).max(5) })
  .strict();
const ffufArgumentsSchema = inputArtifactSchema
  .extend({
    matchCodes: z.array(z.number().int().min(100).max(599)).min(1).max(20),
    maxTargets: z.number().int().min(1).max(3),
  })
  .strict();
const nmapArgumentsSchema = inputArtifactSchema
  .extend({
    ports: z.array(z.number().int().min(1).max(65535)).min(1).max(128),
  })
  .strict();
const validationArgumentsSchema = z
  .object({
    findingId: z.string().uuid(),
    method: z.enum(['GET', 'HEAD']),
    expectedStatus: z.number().int().min(100).max(599).optional(),
    bodyContains: z.string().min(1).max(200).optional(),
  })
  .strict();

export class ActionService {
  constructor(
    private readonly database: WebDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventHub,
    private readonly runner: DockerScannerRunner,
  ) {}

  rawProfileAvailable(): boolean {
    return this.runner.rawProfileAvailable();
  }

  propose(input: {
    engagementId: string;
    sessionId: string;
    turnId?: string;
    action: WebActionName;
    arguments: Record<string, unknown>;
    reason: string;
    scopeVersion: number;
    mode: WebMode;
  }): ActionProposalRecord {
    const normalizedArguments = normalizeArguments(input.action, input.arguments);
    const risk = input.action === 'katana' ? 'medium' : 'high';
    const proposal = this.database.createActionProposal({
      engagementId: input.engagementId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      action: input.action,
      arguments: normalizedArguments,
      reason: z.string().trim().min(1).max(500).parse(input.reason),
      risk,
      scopeVersion: input.scopeVersion,
      approvalHash: actionApprovalHash({
        action: input.action,
        arguments: normalizedArguments,
        scopeVersion: input.scopeVersion,
        mode: input.mode,
      }),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    this.events.publish({
      engagementId: proposal.engagementId,
      sessionId: proposal.sessionId,
      turnId: proposal.turnId,
      type: 'action.proposed',
      payload: publicProposal(proposal),
    });
    return proposal;
  }

  claim(proposalId: string, approvalHash: string, browserSessionId: string): ActionProposalRecord {
    const pending = this.database.getActionProposal(proposalId);
    if (!pending) throw new Error('action proposal not found');
    const engagement = this.database.getEngagement(pending.engagementId);
    if (!engagement) throw new Error('engagement not found');
    if (engagement.mode !== 'RECON') throw new Error('scanner actions require RECON mode');
    const expectedHash = actionApprovalHash({
      action: pending.action,
      arguments: pending.arguments,
      scopeVersion: engagement.scope.version,
      mode: engagement.mode,
    });
    if (expectedHash !== pending.approvalHash || approvalHash !== expectedHash)
      throw new Error('action proposal hash mismatch');
    const claimed = this.database.claimActionProposal(
      proposalId,
      approvalHash,
      browserSessionId,
      engagement.scope.version,
    );
    this.database.audit(claimed.sessionId, 'action.approved', {
      proposalId: claimed.id,
      action: claimed.action,
      approvalHash: claimed.approvalHash,
      scopeVersion: claimed.scopeVersion,
    });
    this.events.publish({
      engagementId: claimed.engagementId,
      sessionId: claimed.sessionId,
      turnId: claimed.turnId,
      type: 'action.approved',
      payload: publicProposal(claimed),
    });
    return claimed;
  }

  reject(proposalId: string, sessionId: string): ActionProposalRecord {
    const proposal = this.database.getActionProposal(proposalId);
    if (!proposal || proposal.sessionId !== sessionId) throw new Error('action proposal not found');
    if (proposal.status !== 'pending') throw new Error('action proposal is no longer pending');
    const rejected = this.database.rejectActionProposal(proposal.id, sessionId);
    this.database.audit(sessionId, 'action.rejected', {
      proposalId: rejected.id,
      action: rejected.action,
      approvalHash: rejected.approvalHash,
    });
    this.events.publish({
      engagementId: rejected.engagementId,
      sessionId: rejected.sessionId,
      turnId: rejected.turnId,
      type: 'action.rejected',
      payload: publicProposal(rejected),
    });
    return rejected;
  }

  async executeClaimed(proposal: ActionProposalRecord, signal: AbortSignal): Promise<void> {
    const engagement = this.database.getEngagement(proposal.engagementId);
    if (!engagement || engagement.scope.version !== proposal.scopeVersion)
      throw new Error('scope changed before action execution');
    let partialArtifactId: string | undefined;
    const reconRun = this.reconRunForProposal(proposal);
    const reconToolRun = reconRun
      ? this.database.createReconToolRun({
          reconRunId: reconRun.id,
          engagementId: proposal.engagementId,
          sessionId: proposal.sessionId,
          tool: proposal.action,
          actionName: `approved_${proposal.action}`,
          metadata: { proposalId: proposal.id, approvalHash: proposal.approvalHash },
        })
      : undefined;
    if (reconRun && reconToolRun)
      this.publishReconTool(reconRun.id, proposal, reconToolRun.id, 'queued');
    try {
      if (reconRun && reconToolRun) {
        this.database.updateReconToolRun(reconToolRun.id, 'running');
        this.publishReconTool(reconRun.id, proposal, reconToolRun.id, 'running');
      }
      const execution = await this.execute(proposal, engagement.scope, signal);
      const { result, targets } = execution;
      const metrics = scannerMetrics(result.stdout);
      if (reconRun && reconToolRun) {
        this.database.updateReconToolRun(reconToolRun.id, 'saving', {
          exitCode: result.exitCode,
          ...metrics,
        });
        this.publishReconTool(reconRun.id, proposal, reconToolRun.id, 'saving');
      }
      const artifactKind = artifactDetails(proposal.action);
      const artifact = await this.artifacts.save({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        kind: artifactKind.kind,
        filename: `${proposal.action}-${proposal.id}.${artifactKind.extension}`,
        mediaType: artifactKind.mediaType,
        body: `${result.stdout.trim()}${result.stdout.trim() ? '\n' : ''}`,
        metadata: {
          tool: proposal.action,
          proposalId: proposal.id,
          targets: targets.length,
          scopeVersion: proposal.scopeVersion,
          scannerIsolation: 'docker',
          scannerProfile: result.profile,
          scannerImage: result.image,
          exitCode: result.exitCode,
          termination: result.termination,
          partial: result.exitCode !== 0 || result.termination !== 'exit',
          ...(proposal.action === 'nuclei'
            ? { templatesCommit: '7d66fa06cc0a5ad85f7bf35f18cf8ee9218fa9a5' }
            : {}),
        },
        directory: reconRun
          ? [
              'engagements',
              proposal.engagementId,
              'recon',
              reconRun.id,
              proposal.action,
              proposal.id,
            ]
          : undefined,
      });
      partialArtifactId = artifact.id;
      if (reconRun && reconToolRun)
        this.database.linkReconArtifact({
          runId: reconRun.id,
          toolRunId: reconToolRun.id,
          artifactId: artifact.id,
          role: 'raw',
        });
      this.recordResults(proposal, artifact.id, targets, result.stdout, engagement.scope);
      if (result.exitCode !== 0)
        throw new Error(
          `${proposal.action} exited ${result.exitCode}: ${result.stderr.slice(0, 1000)}`,
        );
      this.database.finishActionProposal(proposal.id, 'completed', artifact.id);
      if (reconRun && reconToolRun) {
        this.database.updateReconToolRun(reconToolRun.id, 'completed', {
          exitCode: result.exitCode,
          ...metrics,
          artifactIds: [artifact.id],
        });
        this.publishReconTool(reconRun.id, proposal, reconToolRun.id, 'completed', {
          artifactIds: [artifact.id],
          ...metrics,
        });
      }
      this.events.publish({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        type: 'action.completed',
        payload: { proposalId: proposal.id, action: proposal.action, artifactId: artifact.id },
      });
    } catch (error) {
      const status = signal.aborted ? 'cancelled' : 'failed';
      const message = clean(error instanceof Error ? error.message : String(error)).slice(0, 1000);
      this.database.finishActionProposal(proposal.id, status, partialArtifactId, message);
      if (reconRun && reconToolRun) {
        const toolStatus = signal.aborted
          ? 'cancelled'
          : /timed?\s*out|timeout/i.test(message)
            ? 'timed_out'
            : 'failed';
        const artifact = partialArtifactId
          ? this.database.getArtifact(partialArtifactId)
          : undefined;
        const metrics = artifact
          ? scannerMetrics(this.artifacts.read(artifact).toString('utf8'))
          : { rawResults: 0, validResults: 0, uniqueResults: 0 };
        this.database.updateReconToolRun(reconToolRun.id, toolStatus, {
          ...metrics,
          artifactIds: partialArtifactId ? [partialArtifactId] : [],
          error: message,
        });
        this.publishReconTool(reconRun.id, proposal, reconToolRun.id, toolStatus, {
          artifactIds: partialArtifactId ? [partialArtifactId] : [],
          ...metrics,
          error: message,
        });
        if (partialArtifactId && metrics.validResults > 0)
          this.publishReconTool(reconRun.id, proposal, reconToolRun.id, 'partial', {
            artifactIds: [partialArtifactId],
            ...metrics,
            terminalStatus: toolStatus,
          });
      }
      this.events.publish({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        type: `action.${status}`,
        payload: {
          proposalId: proposal.id,
          action: proposal.action,
          ...(partialArtifactId
            ? { artifactId: partialArtifactId, partialResultsSaved: true }
            : {}),
          ...(status === 'failed' ? { error: message } : {}),
        },
      });
      throw error;
    }
  }

  private reconRunForProposal(proposal: ActionProposalRecord) {
    if (proposal.action === 'validate_http') return undefined;
    const artifactId =
      typeof proposal.arguments.inputArtifactId === 'string'
        ? proposal.arguments.inputArtifactId
        : undefined;
    const artifact = artifactId ? this.database.getArtifact(artifactId) : undefined;
    const runId =
      typeof artifact?.metadata.runId === 'string' ? artifact.metadata.runId : undefined;
    const run = runId ? this.database.getReconRun(runId) : undefined;
    return run?.sessionId === proposal.sessionId ? run : undefined;
  }

  private publishReconTool(
    runId: string,
    proposal: ActionProposalRecord,
    toolRunId: string,
    status: string,
    detail: Record<string, unknown> = {},
  ): void {
    this.events.publish({
      engagementId: proposal.engagementId,
      sessionId: proposal.sessionId,
      turnId: proposal.turnId,
      type: `recon.tool.${status}`,
      payload: {
        runId,
        toolRunId,
        tool: proposal.action,
        proposalId: proposal.id,
        status,
        ...detail,
      },
    });
  }

  private async execute(
    proposal: ActionProposalRecord,
    scope: ScopeDefinition,
    signal: AbortSignal,
  ): Promise<{
    result: Awaited<ReturnType<DockerScannerRunner['katana']>>;
    targets: string[];
  }> {
    if (proposal.action === 'validate_http') {
      const args = validationArgumentsSchema.parse(proposal.arguments);
      const finding = this.database.getFinding(args.findingId);
      if (!finding || finding.sessionId !== proposal.sessionId)
        throw new Error('finding was not found in this session');
      const url = safeHttpUrl(finding.url);
      if (!url || !hostInScope(url.hostname, scope))
        throw new Error('finding URL is no longer in scope');
      return {
        result: await this.runner.validateHttp(url.href, args, scope.limits, signal),
        targets: [url.href],
      };
    }
    const targets = this.authorizedTargets(proposal, scope);
    if (proposal.action === 'katana')
      return {
        result: await this.runner.katana(
          targets,
          katanaArgumentsSchema.parse(proposal.arguments),
          scope.limits,
          signal,
        ),
        targets,
      };
    if (proposal.action === 'nuclei')
      return {
        result: await this.runner.nuclei(
          targets,
          nucleiArgumentsSchema.parse(proposal.arguments),
          scope.limits,
          signal,
        ),
        targets,
      };
    if (proposal.action === 'ffuf') {
      const args = ffufArgumentsSchema.parse(proposal.arguments);
      const selected = targets.slice(0, args.maxTargets);
      const results = [];
      for (const target of selected) {
        if (signal.aborted) throw signal.reason;
        results.push(await this.runner.ffuf(target, args, scope.limits, signal));
      }
      const failed = results.find((item) => item.exitCode !== 0);
      return {
        result: failed ?? {
          stdout: results
            .map((item) => item.stdout.trim())
            .filter(Boolean)
            .join('\n'),
          stderr: results
            .map((item) => item.stderr.trim())
            .filter(Boolean)
            .join('\n'),
          exitCode: 0,
          profile: 'safe',
          image: results[0]?.image ?? '',
        },
        targets: selected,
      };
    }
    const hosts = [...new Set(targets.map((target) => new URL(target).hostname))];
    const args = nmapArgumentsSchema.parse(proposal.arguments);
    const raw = proposal.action === 'nmap_raw';
    return {
      result: await this.runner.nmap(hosts, { ports: args.ports, raw }, scope.limits, signal),
      targets: hosts,
    };
  }

  private recordResults(
    proposal: ActionProposalRecord,
    artifactId: string,
    targets: string[],
    stdout: string,
    scope: ScopeDefinition,
  ): void {
    if (proposal.action === 'katana') this.recordKatanaCoverage(proposal, stdout, scope);
    else if (proposal.action === 'nuclei')
      this.recordNucleiResults(proposal, artifactId, targets, stdout, scope);
    else if (proposal.action === 'ffuf') this.recordFfufCoverage(proposal, stdout, scope);
    else if (proposal.action === 'nmap_connect' || proposal.action === 'nmap_raw')
      this.recordNmapCoverage(proposal, targets);
    else this.recordValidationResult(proposal, artifactId, stdout, scope);
  }

  private recordFfufCoverage(
    proposal: ActionProposalRecord,
    stdout: string,
    scope: ScopeDefinition,
  ): void {
    for (const row of parseJsonLines(stdout).slice(0, scope.limits.maxUrlsPerHost)) {
      const raw = readString(row, ['url']);
      const url = raw ? safeHttpUrl(raw) : undefined;
      if (!url || !hostInScope(url.hostname, scope)) continue;
      this.database.upsertCoverage({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        asset: url.hostname,
        endpoint: `GET ${url.pathname}`,
        parameter: 'path',
        vulnerabilityClass: 'content-discovery',
        status: 'untested',
        source: 'ffuf',
        notes: `HTTP ${String(row.status ?? 'unknown')} discovered by approved bounded wordlist fuzzing.`,
      });
    }
  }

  private recordNmapCoverage(proposal: ActionProposalRecord, targets: string[]): void {
    const args = nmapArgumentsSchema.parse(proposal.arguments);
    for (const host of targets) {
      this.database.upsertCoverage({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        asset: host,
        endpoint: `TCP ${args.ports.join(',')}`,
        parameter: '*',
        vulnerabilityClass:
          proposal.action === 'nmap_raw' ? 'syn-port-discovery' : 'connect-port-discovery',
        status: 'tried',
        source: proposal.action,
        notes: `Approved ${proposal.action === 'nmap_raw' ? 'raw SYN' : 'TCP connect'} profile completed.`,
      });
    }
  }

  private recordValidationResult(
    proposal: ActionProposalRecord,
    artifactId: string,
    stdout: string,
    scope: ScopeDefinition,
  ): void {
    const args = validationArgumentsSchema.parse(proposal.arguments);
    const finding = this.database.getFinding(args.findingId);
    if (!finding) throw new Error('finding disappeared during validation');
    const status = Number.parseInt(stdout.match(/^HTTP\/\S+\s+(\d{3})/m)?.[1] ?? '0', 10);
    const statusMatches = args.expectedStatus === undefined || status === args.expectedStatus;
    const bodyMatches = args.bodyContains === undefined || stdout.includes(args.bodyContains);
    const reproduced = statusMatches && bodyMatches;
    const url = new URL(finding.url);
    if (hostInScope(url.hostname, scope)) {
      this.database.upsertCoverage({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        asset: url.hostname,
        endpoint: `${args.method} ${url.pathname}`,
        parameter: '*',
        vulnerabilityClass: `validation:${finding.scannerReference}`,
        status: reproduced ? 'passed' : 'failed',
        source: 'validate_http',
        notes: `HTTP ${status || 'unknown'}; status assertion ${statusMatches ? 'matched' : 'failed'}; body assertion ${bodyMatches ? 'matched' : 'failed'}. Manual confirmation is still required.`,
      });
    }
    this.events.publish({
      engagementId: proposal.engagementId,
      sessionId: proposal.sessionId,
      turnId: proposal.turnId,
      type: 'validation.checked',
      payload: {
        proposalId: proposal.id,
        findingId: finding.id,
        artifactId,
        reproduced,
        httpStatus: status || undefined,
        statusMatches,
        bodyMatches,
        requiresManualConfirmation: true,
      },
    });
  }

  private authorizedTargets(proposal: ActionProposalRecord, scope: ScopeDefinition): string[] {
    const inputArtifactId = z.string().uuid().parse(proposal.arguments.inputArtifactId);
    const source = this.database.getArtifact(inputArtifactId);
    if (!source || source.sessionId !== proposal.sessionId)
      throw new Error('input artifact was not found in this session');
    const body = this.artifacts.read(source).toString('utf8');
    const values = parseArtifactValues(body, source.mediaType);
    const candidates = values.flatMap(extractCandidateValues);
    const authorized = new Set<string>();
    for (const candidate of candidates) {
      const url = safeHttpUrl(candidate);
      if (!url || !hostInScope(url.hostname, scope)) continue;
      url.hash = '';
      authorized.add(url.href);
      if (authorized.size >= scope.limits.maxUrlsPerHost) break;
    }
    if (authorized.size === 0)
      throw new Error('input artifact contains no in-scope HTTP(S) targets');
    return [...authorized];
  }

  private recordKatanaCoverage(
    proposal: ActionProposalRecord,
    stdout: string,
    scope: ScopeDefinition,
  ): void {
    for (const row of parseJsonLines(stdout).slice(0, scope.limits.maxUrlsPerHost)) {
      const raw = readString(row, ['request.endpoint', 'request.url', 'url']);
      const url = raw ? safeHttpUrl(raw) : undefined;
      if (!url) continue;
      const classified = classifyDiscoveredValue(url.href, scope);
      if (!classified.inScope) continue;
      this.database.upsertCoverage({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        asset: url.hostname,
        endpoint: `${readString(row, ['request.method', 'method']) || 'GET'} ${url.pathname}`,
        parameter: '*',
        vulnerabilityClass: 'endpoint-discovery',
        status: 'untested',
        source: 'katana',
        notes: 'Discovered by the approved, scoped crawler.',
      });
    }
  }

  private recordNucleiResults(
    proposal: ActionProposalRecord,
    artifactId: string,
    targets: string[],
    stdout: string,
    scope: ScopeDefinition,
  ): void {
    for (const target of targets) {
      const url = new URL(target);
      this.database.upsertCoverage({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        asset: url.hostname,
        endpoint: `HTTP ${url.pathname}`,
        parameter: '*',
        vulnerabilityClass: 'nuclei-safe-http-templates',
        status: 'tried',
        source: 'nuclei',
        notes: 'Approved safe HTTP template set executed; scanner hits require validation.',
      });
    }
    for (const row of parseJsonLines(stdout)) {
      const url = readString(row, ['matched-at', 'url', 'host']);
      const parsedUrl = url ? safeHttpUrl(url) : undefined;
      if (!parsedUrl || !hostInScope(parsedUrl.hostname, scope)) continue;
      const info = isRecord(row.info) ? row.info : {};
      const templateId = readString(row, ['template-id', 'templateID']) || 'unknown-template';
      const severity = severitySchema
        .catch('info')
        .parse(readString(info, ['severity'])?.toLowerCase());
      const finding = this.database.insertFinding({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        actionProposalId: proposal.id,
        evidenceArtifactId: artifactId,
        title: readString(info, ['name']) || templateId,
        severity: severity as FindingSeverity,
        status: severity === 'info' ? 'informational' : 'needs_validation',
        confidence: 'scanner',
        url: parsedUrl.href,
        scanner: 'nuclei',
        scannerReference: templateId,
        description: readString(info, ['description']),
        remediation: readString(info, ['remediation']),
      });
      if (finding) {
        this.events.publish({
          engagementId: proposal.engagementId,
          sessionId: proposal.sessionId,
          turnId: proposal.turnId,
          type: 'finding.created',
          payload: finding,
        });
      }
    }
  }
}

export function publicProposal(proposal: ActionProposalRecord): ActionProposalRecord {
  return { ...proposal, approvedBy: undefined };
}

function normalizeArguments(
  action: WebActionName,
  value: Record<string, unknown>,
): Record<string, unknown> {
  switch (action) {
    case 'katana':
      return katanaArgumentsSchema.parse(value);
    case 'nuclei':
      return nucleiArgumentsSchema.parse(value);
    case 'ffuf':
      return ffufArgumentsSchema.parse(value);
    case 'nmap_connect':
    case 'nmap_raw': {
      const parsed = nmapArgumentsSchema.parse(value);
      return { ...parsed, ports: [...new Set(parsed.ports)].sort((a, b) => a - b) };
    }
    case 'validate_http':
      return validationArgumentsSchema.parse(value);
  }
}

function artifactDetails(action: WebActionName): {
  kind: string;
  extension: string;
  mediaType: string;
} {
  switch (action) {
    case 'katana':
      return { kind: 'crawl-observations', extension: 'jsonl', mediaType: 'application/x-ndjson' };
    case 'nuclei':
    case 'ffuf':
      return { kind: 'scanner-results', extension: 'jsonl', mediaType: 'application/x-ndjson' };
    case 'nmap_connect':
    case 'nmap_raw':
      return { kind: 'port-scan-results', extension: 'xml', mediaType: 'application/xml' };
    case 'validate_http':
      return { kind: 'validation-evidence', extension: 'http', mediaType: 'text/plain' };
  }
}

function parseArtifactValues(body: string, mediaType: string): unknown[] {
  if (mediaType.includes('ndjson')) return parseJsonLines(body);
  try {
    const parsed = JSON.parse(body) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error('input artifact is not valid JSON or JSONL');
  }
}

function extractCandidateValues(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const direct = [value.url, value.input, value.value, value.host].filter(
    (item): item is string => typeof item === 'string',
  );
  const request = isRecord(value.request) ? value.request : undefined;
  if (request) {
    for (const item of [request.endpoint, request.url])
      if (typeof item === 'string') direct.push(item);
  }
  return direct.map((item) => (/^https?:\/\//i.test(item) ? item : `https://${item}`));
}

function parseJsonLines(value: string): Record<string, unknown>[] {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function scannerMetrics(value: string): {
  rawResults: number;
  validResults: number;
  uniqueResults: number;
} {
  const lines = value.split(/\r?\n/).filter(Boolean);
  const parsed = parseJsonLines(value);
  const values =
    parsed.length > 0
      ? parsed.flatMap(extractCandidateValues).map((item) => item.toLowerCase())
      : lines;
  return {
    rawResults: lines.length,
    validResults: parsed.length > 0 ? parsed.length : lines.length,
    uniqueResults: new Set(values).size,
  };
}

function safeHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function readString(value: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    let current: unknown = value;
    for (const part of path.split('.')) current = isRecord(current) ? current[part] : undefined;
    if (typeof current === 'string' && current) return current;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
