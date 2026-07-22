import { AlwaysAllow } from '../../permission/permission.js';
import type { ActionService } from '../actions/service.js';
import type { EventHub } from '../events.js';
import type { DockerScannerRunner } from '../scanners/dockerRunner.js';
import { clean } from '../scanners/output.js';
import { classifyDiscoveredValue, normalizeHost } from '../scope.js';
import type { ArtifactStore } from '../storage/artifacts.js';
import type { WebDatabase } from '../storage/database.js';
import {
  DnsxTool,
  HttpxTool,
  type ReconToolContext,
  ScopeTargetsTool,
  SubfinderTool,
} from '../tools/recon.js';
import type {
  ReconInsightRecord,
  ReconProfile,
  ReconRunRecord,
  ScopeDefinition,
} from '../types.js';

const STEPS = [
  { key: 'scope', label: 'Scope snapshot' },
  { key: 'passive', label: 'Passive subdomain discovery' },
  { key: 'dns', label: 'DNS resolution' },
  { key: 'http', label: 'HTTP service probing' },
  { key: 'analysis', label: 'Analysis and next actions' },
];

export class ReconService {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly database: WebDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventHub,
    private readonly runner: DockerScannerRunner,
    private readonly actions: ActionService,
  ) {}

  list(sessionId: string): ReconRunRecord[] {
    return this.database.listReconRuns(sessionId);
  }

  start(sessionId: string, profile: ReconProfile): ReconRunRecord {
    const session = this.database.getSession(sessionId);
    if (!session) throw new Error('session not found');
    if (session.state === 'running')
      throw new Error('another session operation is already running');
    const engagement = this.database.getEngagement(session.engagementId);
    if (!engagement) throw new Error('engagement not found');
    if (engagement.mode !== 'RECON') throw new Error('recon runs require a RECON engagement');
    const exact = engagement.scope.allowedHosts.filter((host) => !host.startsWith('*.'));
    if (exact.length === 0) throw new Error('scope must include at least one exact root host');
    const run = this.database.createReconRun(sessionId, engagement.id, profile, STEPS);
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.database.startReconRun(run.id);
    this.database.setSessionState(sessionId, 'running');
    this.publish(run, 'recon.run.started', { runId: run.id, profile });
    void this.execute(run.id, controller)
      .catch(() => undefined)
      .finally(() => this.controllers.delete(run.id));
    return this.database.getReconRun(run.id) ?? run;
  }

  cancel(sessionId: string, runId: string): boolean {
    const run = this.database.getReconRun(runId);
    if (!run || run.sessionId !== sessionId) throw new Error('recon run not found');
    const controller = this.controllers.get(runId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error('recon cancelled by operator'));
    this.publish(run, 'recon.run.cancel-requested', { runId });
    this.database.audit(sessionId, 'recon.cancel_requested', { runId });
    return true;
  }

  updateInsight(
    sessionId: string,
    insightId: string,
    status: ReconInsightRecord['status'],
  ): ReconInsightRecord {
    const insight = this.database.updateReconInsight(insightId, sessionId, status);
    this.database.audit(sessionId, 'recon.insight_updated', { insightId, status });
    return insight;
  }

  private async execute(runId: string, controller: AbortController): Promise<void> {
    const run = this.requireRun(runId);
    const engagement = this.database.getEngagement(run.engagementId);
    if (!engagement) throw new Error('engagement not found');
    const context: ReconToolContext = {
      engagementId: engagement.id,
      sessionId: run.sessionId,
      turnId: () => undefined,
      scope: () => engagement.scope,
    };
    const prompter = new AlwaysAllow();
    let currentStep = 'scope';
    try {
      currentStep = 'scope';
      this.step(run, currentStep, 'running');
      const scopeResult = parseToolResult(
        await new ScopeTargetsTool(context, this.artifacts).run({}, controller.signal, prompter),
      );
      const scopeArtifactId = requiredArtifactId(scopeResult);
      this.step(run, currentStep, 'completed', {
        artifactId: scopeArtifactId,
        metrics: { targets: numberValue(scopeResult.total) },
      });

      const discovered = readAssetArray(
        this.database,
        this.artifacts,
        scopeArtifactId,
        engagement.scope,
      );
      currentStep = 'passive';
      if (!engagement.scope.allowThirdPartyPassiveSources) {
        this.step(run, currentStep, 'skipped', {
          detail: 'Third-party passive sources are disabled for this scope.',
        });
      } else {
        this.step(run, currentStep, 'running');
        const roots = [
          ...new Set(
            engagement.scope.allowedHosts
              .map((host) => normalizeHost(host.startsWith('*.') ? host.slice(2) : host))
              .slice(0, 10),
          ),
        ];
        for (const domain of roots) {
          const result = parseToolResult(
            await new SubfinderTool(context, this.runner, this.artifacts).run(
              { domain },
              controller.signal,
              prompter,
            ),
          );
          discovered.push(
            ...readAssetArray(
              this.database,
              this.artifacts,
              requiredArtifactId(result),
              engagement.scope,
            ),
          );
        }
        this.step(run, currentStep, 'completed', {
          metrics: {
            discovered: discovered.length,
            inScope: discovered.filter((asset) => asset.inScope).length,
          },
        });
      }

      const combined = dedupeAssets(discovered).slice(0, engagement.scope.limits.maxUrlsPerHost);
      const combinedArtifact = await this.artifacts.save({
        engagementId: engagement.id,
        sessionId: run.sessionId,
        kind: 'recon-targets',
        filename: `recon-${run.id}-targets.json`,
        mediaType: 'application/json',
        body: `${JSON.stringify(combined, null, 2)}\n`,
        metadata: {
          runId: run.id,
          total: combined.length,
          inScope: combined.filter((asset) => asset.inScope).length,
        },
      });

      let httpArtifactId: string | undefined;
      if (!engagement.scope.allowDirectLowImpactRecon) {
        currentStep = 'dns';
        this.step(run, currentStep, 'skipped', {
          detail: 'Direct low-impact recon is disabled for this scope.',
        });
        currentStep = 'http';
        this.step(run, currentStep, 'skipped', {
          detail: 'HTTP probing requires direct low-impact recon permission.',
        });
      } else {
        currentStep = 'dns';
        this.step(run, currentStep, 'running');
        const dnsResult = parseToolResult(
          await new DnsxTool(context, this.runner, this.artifacts, this.database).run(
            { inputArtifactId: combinedArtifact.id },
            controller.signal,
          ),
        );
        this.step(run, currentStep, 'completed', {
          artifactId: requiredArtifactId(dnsResult),
          metrics: {
            targets: numberValue(dnsResult.targets),
            observations: numberValue(dnsResult.observations),
          },
        });

        currentStep = 'http';
        this.step(run, currentStep, 'running');
        const httpResult = parseToolResult(
          await new HttpxTool(context, this.runner, this.artifacts, this.database).run(
            { inputArtifactId: combinedArtifact.id, followRedirects: false },
            controller.signal,
            prompter,
          ),
        );
        httpArtifactId = requiredArtifactId(httpResult);
        this.step(run, currentStep, 'completed', {
          artifactId: httpArtifactId,
          metrics: {
            targets: numberValue(httpResult.targets),
            observations: numberValue(httpResult.observations),
          },
        });
      }

      currentStep = 'analysis';
      this.step(run, currentStep, 'running');
      const observations = httpArtifactId
        ? readJsonArray(this.database, this.artifacts, httpArtifactId)
        : [];
      const insightCount = this.createInsights(run, observations);
      const proposalCount = httpArtifactId
        ? this.createFollowUpProposals(
            run,
            httpArtifactId,
            engagement.scope.version,
            engagement.mode,
          )
        : 0;
      this.step(run, currentStep, 'completed', {
        metrics: { insights: insightCount, approvalProposals: proposalCount },
      });
      const summary = {
        assets: combined.length,
        inScopeAssets: combined.filter((asset) => asset.inScope).length,
        httpObservations: observations.length,
        insights: insightCount,
        approvalProposals: proposalCount,
        scopeEnforcement: 'fail-closed inputs; best-effort network enforcement',
      };
      this.database.finishReconRun(run.id, 'completed', summary);
      this.database.setSessionState(run.sessionId, 'idle');
      this.publish(run, 'recon.run.completed', { runId: run.id, summary });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = safeError(error);
      this.step(run, currentStep, cancelled ? 'cancelled' : 'failed', { detail: message });
      this.database.finishReconRun(run.id, cancelled ? 'cancelled' : 'failed', {
        error: message,
      });
      this.database.setSessionState(run.sessionId, cancelled ? 'cancelled' : 'error');
      this.publish(run, cancelled ? 'recon.run.cancelled' : 'recon.run.failed', {
        runId: run.id,
        error: message,
      });
    }
  }

  private createInsights(run: ReconRunRecord, observations: unknown[]): number {
    const seen = new Set<string>();
    let count = 0;
    for (const row of observations) {
      if (!isRecord(row)) continue;
      const target =
        typeof row.url === 'string' ? row.url : typeof row.input === 'string' ? row.input : '';
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const haystack =
        `${target} ${String(row.title ?? '')} ${JSON.stringify(row.tech ?? row.technologies ?? [])}`.toLowerCase();
      const priority = /admin|internal|staging|dev\.|api\.|auth|login|oauth|graphql/.test(haystack)
        ? 'high'
        : 'medium';
      const skill = /oauth|login|auth/.test(haystack)
        ? 'oauth-oidc'
        : /api\.|graphql|\/api\//.test(haystack)
          ? 'api-authorization'
          : undefined;
      this.database.addReconInsight({
        runId: run.id,
        sessionId: run.sessionId,
        type: 'asset',
        priority,
        title: String(row.title || new URL(target).hostname).slice(0, 180),
        rationale: `Live HTTP service${row.status_code ? ` returned ${String(row.status_code)}` : ''}; review technology and access boundaries before deeper testing.`,
        target,
        skill,
        sourceStep: 'http',
      });
      count += 1;
      if (count >= 100) break;
    }
    const recommendations: Array<{
      title: string;
      rationale: string;
      skill: string;
      priority: 'high' | 'medium';
    }> = [
      {
        title: 'Build an API authorization matrix',
        rationale:
          'Use two controlled accounts to test object, role, and tenant boundaries on discovered APIs.',
        skill: 'api-authorization',
        priority: 'high',
      },
      {
        title: 'Map business workflow invariants',
        rationale: 'Prioritize multi-step transactions that scanners cannot reason about safely.',
        skill: 'business-logic',
        priority: 'medium',
      },
      {
        title: 'Review upload and document pipelines',
        rationale:
          'If an upload surface is present, test validation, storage, serving, and authorization with inert files.',
        skill: 'file-upload',
        priority: 'medium',
      },
    ];
    for (const item of recommendations) {
      this.database.addReconInsight({
        runId: run.id,
        sessionId: run.sessionId,
        type: 'manual-test',
        priority: item.priority,
        title: item.title,
        rationale: item.rationale,
        skill: item.skill,
        sourceStep: 'analysis',
      });
      count += 1;
    }
    return count;
  }

  private createFollowUpProposals(
    run: ReconRunRecord,
    artifactId: string,
    scopeVersion: number,
    mode: 'PLAN' | 'RECON',
  ): number {
    if (run.profile === 'quick') return 0;
    const common = {
      engagementId: run.engagementId,
      sessionId: run.sessionId,
      scopeVersion,
      mode,
    };
    this.actions.propose({
      ...common,
      action: 'katana',
      arguments: { inputArtifactId: artifactId, depth: run.profile === 'advanced' ? 2 : 1 },
      reason: 'Crawl discovered in-scope HTTP services with redirects disabled and bounded depth.',
    });
    this.actions.propose({
      ...common,
      action: 'nuclei',
      arguments: { inputArtifactId: artifactId, severities: ['critical', 'high', 'medium'] },
      reason: 'Run pinned safe HTTP Nuclei templates; all hits remain needs-validation.',
    });
    if (run.profile !== 'advanced') return 2;
    this.actions.propose({
      ...common,
      action: 'ffuf',
      arguments: {
        inputArtifactId: artifactId,
        matchCodes: [200, 204, 301, 302, 401, 403],
        maxTargets: 3,
      },
      reason: 'Perform bounded content discovery on at most three selected in-scope services.',
    });
    this.actions.propose({
      ...common,
      action: 'nmap_connect',
      arguments: { inputArtifactId: artifactId, ports: [80, 443, 8080, 8443] },
      reason: 'Check a small server-defined TCP port set with the unprivileged connect profile.',
    });
    return 4;
  }

  private step(
    run: ReconRunRecord,
    key: string,
    status: 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled',
    input: { artifactId?: string; detail?: string; metrics?: Record<string, unknown> } = {},
  ): void {
    const step = this.database.updateReconStep(run.id, key, status, input);
    this.publish(run, `recon.step.${status}`, {
      runId: run.id,
      step: key,
      label: step.label,
      ...input,
    });
  }

  private publish(run: ReconRunRecord, type: string, payload: Record<string, unknown>): void {
    this.events.publish({
      engagementId: run.engagementId,
      sessionId: run.sessionId,
      type,
      payload,
    });
  }

  private requireRun(id: string): ReconRunRecord {
    const run = this.database.getReconRun(id);
    if (!run) throw new Error('recon run not found');
    return run;
  }
}

type Asset = {
  value: string;
  host: string;
  inScope: boolean;
  activeTestingAllowed: boolean;
  discoveredBy?: string;
};

function parseToolResult(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error('recon tool returned an invalid result');
  return parsed;
}

function requiredArtifactId(value: Record<string, unknown>): string {
  if (typeof value.artifactId !== 'string') throw new Error('recon tool did not save an artifact');
  return value.artifactId;
}

function readAssetArray(
  database: WebDatabase,
  artifacts: ArtifactStore,
  id: string,
  scope: ScopeDefinition,
): Asset[] {
  return readJsonArray(database, artifacts, id).flatMap((item) => {
    if (!isRecord(item) || typeof item.host !== 'string') return [];
    try {
      const classified = classifyDiscoveredValue(item.host, scope);
      return [
        {
          ...classified,
          discoveredBy: typeof item.discoveredBy === 'string' ? item.discoveredBy : undefined,
        },
      ];
    } catch {
      return [];
    }
  });
}

function readJsonArray(database: WebDatabase, artifacts: ArtifactStore, id: string): unknown[] {
  const artifact = database.getArtifact(id);
  if (!artifact) throw new Error('recon artifact not found');
  const parsed = JSON.parse(artifacts.read(artifact).toString('utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('recon artifact is not an array');
  return parsed;
}

function dedupeAssets(assets: Asset[]): Asset[] {
  const byHost = new Map<string, Asset>();
  for (const asset of assets) if (!byHost.has(asset.host)) byHost.set(asset.host, asset);
  return [...byHost.values()];
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
