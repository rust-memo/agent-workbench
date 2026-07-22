import { z } from 'zod';
import type { EventHub } from '../events.js';
import type { DockerScannerRunner } from '../scanners/dockerRunner.js';
import { clean } from '../scanners/output.js';
import { classifyDiscoveredValue, hostInScope } from '../scope.js';
import type { ArtifactStore } from '../storage/artifacts.js';
import type { WebDatabase } from '../storage/database.js';
import type { ActionProposalRecord, FindingSeverity, ScopeDefinition, WebMode } from '../types.js';
import { actionApprovalHash } from './canonical.js';

const inputArtifactSchema = z.object({ inputArtifactId: z.string().uuid() }).strict();
const katanaArgumentsSchema = inputArtifactSchema
  .extend({ depth: z.number().int().min(1).max(3) })
  .strict();
const severitySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
const nucleiArgumentsSchema = inputArtifactSchema
  .extend({ severities: z.array(severitySchema).min(1).max(5) })
  .strict();

export class ActionService {
  constructor(
    private readonly database: WebDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventHub,
    private readonly runner: DockerScannerRunner,
  ) {}

  propose(input: {
    engagementId: string;
    sessionId: string;
    turnId?: string;
    action: 'katana' | 'nuclei';
    arguments: Record<string, unknown>;
    reason: string;
    scopeVersion: number;
    mode: WebMode;
  }): ActionProposalRecord {
    const normalizedArguments =
      input.action === 'katana'
        ? katanaArgumentsSchema.parse(input.arguments)
        : nucleiArgumentsSchema.parse(input.arguments);
    const risk = input.action === 'nuclei' ? 'high' : 'medium';
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

  async executeClaimed(proposal: ActionProposalRecord, signal: AbortSignal): Promise<void> {
    const engagement = this.database.getEngagement(proposal.engagementId);
    if (!engagement || engagement.scope.version !== proposal.scopeVersion)
      throw new Error('scope changed before action execution');
    try {
      const targets = this.authorizedTargets(proposal, engagement.scope);
      const result =
        proposal.action === 'katana'
          ? await this.runner.katana(
              targets,
              katanaArgumentsSchema.parse(proposal.arguments),
              engagement.scope.limits,
              signal,
            )
          : await this.runner.nuclei(
              targets,
              nucleiArgumentsSchema.parse(proposal.arguments),
              engagement.scope.limits,
              signal,
            );
      if (result.exitCode !== 0)
        throw new Error(
          `${proposal.action} exited ${result.exitCode}: ${result.stderr.slice(0, 1000)}`,
        );
      const artifact = await this.artifacts.save({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        kind: proposal.action === 'katana' ? 'crawl-observations' : 'scanner-results',
        filename: `${proposal.action}-${proposal.id}.jsonl`,
        mediaType: 'application/x-ndjson',
        body: `${result.stdout.trim()}${result.stdout.trim() ? '\n' : ''}`,
        metadata: {
          tool: proposal.action,
          proposalId: proposal.id,
          targets: targets.length,
          scopeVersion: proposal.scopeVersion,
          scannerIsolation: 'docker',
          ...(proposal.action === 'nuclei'
            ? { templatesCommit: '7d66fa06cc0a5ad85f7bf35f18cf8ee9218fa9a5' }
            : {}),
        },
      });
      if (proposal.action === 'katana')
        this.recordKatanaCoverage(proposal, result.stdout, engagement.scope);
      else
        this.recordNucleiResults(proposal, artifact.id, targets, result.stdout, engagement.scope);
      this.database.finishActionProposal(proposal.id, 'completed', artifact.id);
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
      this.database.finishActionProposal(proposal.id, status, undefined, message);
      this.events.publish({
        engagementId: proposal.engagementId,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        type: `action.${status}`,
        payload: {
          proposalId: proposal.id,
          action: proposal.action,
          ...(status === 'failed' ? { error: message } : {}),
        },
      });
      throw error;
    }
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
