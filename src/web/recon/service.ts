import type { ActionService } from '../actions/service.js';
import type { EventHub } from '../events.js';
import type { DockerScannerRunner, ScannerResult } from '../scanners/dockerRunner.js';
import { clean } from '../scanners/output.js';
import { normalizeHost } from '../scope.js';
import type { ArtifactStore } from '../storage/artifacts.js';
import type { WebDatabase } from '../storage/database.js';
import type {
  ArtifactRecord,
  ReconInsightRecord,
  ReconProfile,
  ReconRunRecord,
  ReconToolRunRecord,
  ScopeDefinition,
} from '../types.js';
import { normalizeReconValue } from './normalize.js';

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

  results(sessionId: string, requestedRunId?: string): Record<string, unknown> {
    const run =
      (requestedRunId
        ? this.database.getReconRun(requestedRunId)
        : this.database.listReconRuns(sessionId)[0]) ?? undefined;
    if (!run || run.sessionId !== sessionId)
      return {
        run: null,
        toolRuns: [],
        assets: [],
        httpResults: [],
        artifactLinks: [],
        interests: [],
      };
    const assets = this.database.listReconAssets(sessionId, run.id);
    return {
      run,
      toolRuns: this.database.listReconToolRuns(run.id),
      assets,
      httpResults: this.database.listReconHttpResults(run.id),
      artifactLinks: this.database.listReconArtifactLinks(run.id),
      interests: Object.fromEntries(
        assets.map((asset) => [asset.id, this.database.listAssetInterest(asset.id)]),
      ),
    };
  }

  markInteresting(
    sessionId: string,
    assetId: string,
    input: {
      score: number;
      reasons: string[];
      reviewStatus: 'new' | 'reviewing' | 'dismissed' | 'promoted';
    },
  ) {
    const asset = this.database.getReconAsset(assetId);
    if (!asset || asset.sessionId !== sessionId) throw new Error('recon asset not found');
    const interest = this.database.addAssetInterest({
      assetId,
      score: input.score,
      reasons: input.reasons,
      markedBy: 'user',
      reviewStatus: input.reviewStatus,
    });
    const run = this.requireRun(asset.runId);
    this.database.audit(sessionId, 'recon.asset_interest_marked', {
      assetId,
      interestId: interest.id,
      score: interest.score,
    });
    this.publish(run, 'recon.asset.updated', {
      runId: run.id,
      assetId,
      interest,
    });
    return interest;
  }

  async createScanProposal(
    sessionId: string,
    input: {
      assetIds: string[];
      action: 'katana' | 'nuclei';
      reason: string;
    },
  ) {
    const session = this.database.getSession(sessionId);
    if (!session) throw new Error('session not found');
    const engagement = this.database.getEngagement(session.engagementId);
    if (!engagement || engagement.mode !== 'RECON') throw new Error('RECON engagement required');
    const assets = input.assetIds.map((id) => {
      const asset = this.database.getReconAsset(id);
      if (!asset || asset.sessionId !== sessionId) throw new Error('selected asset not found');
      if (!asset.inScope || !asset.activeTestingAllowed)
        throw new Error(`active testing is not allowed for ${asset.normalizedValue}`);
      return asset;
    });
    if (!assets.length) throw new Error('select at least one in-scope asset');
    const runId = assets[0]?.runId;
    if (!runId || assets.some((asset) => asset.runId !== runId))
      throw new Error('selected assets must belong to one recon run');
    const selection = await this.artifacts.save({
      engagementId: engagement.id,
      sessionId,
      kind: 'recon-selected-targets',
      filename: `selection-${Date.now()}.json`,
      mediaType: 'application/json',
      body: `${JSON.stringify(
        assets.map((asset) => ({
          url: asset.http?.finalUrl ?? `https://${asset.normalizedValue}`,
          assetId: asset.id,
          sources: [...new Set(asset.sources.map((source) => source.tool))],
        })),
        null,
        2,
      )}\n`,
      metadata: { runId, assetIds: input.assetIds, purpose: input.action },
    });
    this.database.linkReconArtifact({
      runId,
      artifactId: selection.id,
      role: 'combined',
    });
    const proposal = this.actions.propose({
      engagementId: engagement.id,
      sessionId,
      action: input.action,
      arguments:
        input.action === 'katana'
          ? { inputArtifactId: selection.id, depth: 1 }
          : {
              inputArtifactId: selection.id,
              severities: ['critical', 'high', 'medium'],
            },
      reason: input.reason,
      scopeVersion: engagement.scope.version,
      mode: engagement.mode,
    });
    this.database.audit(sessionId, 'recon.scan_proposal_created', {
      runId,
      proposalId: proposal.id,
      action: input.action,
      assetIds: input.assetIds,
      selectionArtifactId: selection.id,
    });
    return proposal;
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
    this.publish(run, 'recon.run.queued', { runId: run.id, profile });
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
    let currentStep = 'scope';
    try {
      currentStep = 'scope';
      this.step(run, currentStep, 'running');
      const roots = [
        ...new Set(
          engagement.scope.allowedHosts
            .map((host) => normalizeHost(host.startsWith('*.') ? host.slice(2) : host))
            .slice(0, 100),
        ),
      ];
      const scopeTool = await this.executeDomainTool(
        run,
        engagement.scope,
        'scope',
        'scope_targets',
        async () => successfulResult(`${roots.join('\n')}\n`),
        parseLineValues,
        controller.signal,
      );
      this.step(run, currentStep, scopeTool.status === 'completed' ? 'completed' : 'failed', {
        artifactId: scopeTool.parsedArtifactId,
        detail: scopeTool.error,
        metrics: { targets: scopeTool.uniqueResults },
      });
      if (!scopeTool.parsedArtifactId || scopeTool.uniqueResults === 0)
        throw new Error(scopeTool.error ?? 'scope targets could not be persisted');

      currentStep = 'passive';
      if (!engagement.scope.allowThirdPartyPassiveSources) {
        this.step(run, currentStep, 'skipped', {
          detail: 'Third-party passive sources are disabled for this scope.',
        });
      } else {
        this.step(run, currentStep, 'running');
        const passiveRuns: DomainToolOutcome[] = [];
        passiveRuns.push(
          await this.executeDomainTool(
            run,
            engagement.scope,
            'subfinder',
            'passive_subdomains',
            () =>
              executeForRoots(
                roots.slice(0, 10),
                (domain) =>
                  this.runner.subfinder(domain, engagement.scope.limits, controller.signal),
                controller.signal,
              ),
            parseLineValues,
            controller.signal,
          ),
        );
        if (typeof this.runner.crtsh === 'function' && !controller.signal.aborted) {
          passiveRuns.push(
            await this.executeDomainTool(
              run,
              engagement.scope,
              'crtsh',
              'certificate_transparency',
              () =>
                executeForRoots(
                  roots.slice(0, 10),
                  (domain) => this.runner.crtsh(domain, engagement.scope.limits, controller.signal),
                  controller.signal,
                  mergeCrtshResults,
                ),
              parseCrtshValues,
              controller.signal,
            ),
          );
        }
        const failed = passiveRuns.filter((item) => item.status !== 'completed');
        this.step(run, currentStep, failed.length === passiveRuns.length ? 'failed' : 'completed', {
          detail:
            failed.length > 0
              ? `${failed.length} passive tool(s) failed; valid partial results were preserved.`
              : undefined,
          metrics: {
            tools: passiveRuns.length,
            discovered: passiveRuns.reduce((sum, item) => sum + item.validResults, 0),
            unique: passiveRuns.reduce((sum, item) => sum + item.uniqueResults, 0),
            partialTools: failed.filter((item) => item.uniqueResults > 0).length,
          },
        });
      }
      if (controller.signal.aborted) throw controller.signal.reason;

      const combined = await this.saveCombined(run);

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
        const dnsResult = await this.executeDnsx(
          run,
          engagement.scope,
          combined.inScopeDomains,
          controller.signal,
        );
        this.step(run, currentStep, dnsResult.status === 'completed' ? 'completed' : 'failed', {
          artifactId: dnsResult.parsedArtifactId,
          detail: dnsResult.error,
          metrics: {
            targets: combined.inScopeDomains.length,
            observations: dnsResult.validResults,
          },
        });

        currentStep = 'http';
        this.step(run, currentStep, 'running');
        const httpResult = await this.executeHttpx(
          run,
          engagement.scope,
          combined.inScopeDomains,
          controller.signal,
        );
        httpArtifactId = httpResult.liveTextArtifactId;
        this.step(run, currentStep, httpResult.status === 'completed' ? 'completed' : 'failed', {
          artifactId: httpArtifactId,
          detail: httpResult.error,
          metrics: {
            targets: combined.inScopeDomains.length,
            observations: httpResult.validResults,
            failedInputs: httpResult.failedInputs,
          },
        });
      }
      if (controller.signal.aborted) throw controller.signal.reason;

      currentStep = 'analysis';
      this.step(run, currentStep, 'running');
      const observations = this.database.listReconHttpResults(run.id).map((result) => result.raw);
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
        ...combined.summary,
        assets: combined.summary.uniqueDomains,
        inScopeAssets: combined.summary.inScopeDomains,
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

  private async executeDomainTool(
    run: ReconRunRecord,
    scope: ScopeDefinition,
    tool: string,
    actionName: string,
    execute: () => Promise<ScannerResult>,
    parse: (stdout: string) => ParsedValues,
    signal: AbortSignal,
  ): Promise<DomainToolOutcome> {
    const toolRun = this.queueTool(run, tool, actionName);
    let result: ScannerResult | undefined;
    const artifactIds: string[] = [];
    try {
      this.transitionTool(run, toolRun.id, 'running');
      result = await execute();
      this.transitionTool(run, toolRun.id, 'saving', {
        exitCode: result.exitCode,
        partialStdout: terminalStatus(result, signal) === 'completed' ? undefined : result.stdout,
        partialStderr: terminalStatus(result, signal) === 'completed' ? undefined : result.stderr,
      });
      const raw = await this.saveReconArtifact(run, toolRun.id, tool, {
        role: 'raw',
        filename: tool === 'crtsh' ? 'raw.json' : 'raw.txt',
        kind: 'recon-tool-raw',
        mediaType: tool === 'crtsh' ? 'application/json' : 'text/plain; charset=utf-8',
        body: withFinalNewline(result.stdout),
        metadata: { tool, actionName, exitCode: result.exitCode },
      });
      artifactIds.push(raw.id);

      const parsed = parse(result.stdout);
      const valid: Array<{ raw: string; asset: ReturnType<typeof normalizeReconValue> }> = [];
      for (const rawValue of parsed.values) {
        try {
          valid.push({ raw: rawValue, asset: normalizeReconValue(rawValue, scope) });
        } catch {
          // Malformed scanner lines are counted in metadata and never promoted to assets.
        }
      }
      const unique = new Map(valid.map((item) => [item.asset.normalizedValue, item.asset]));
      const parsedArtifact = await this.saveReconArtifact(run, toolRun.id, tool, {
        role: 'parsed',
        filename: 'parsed.txt',
        kind: 'recon-tool-parsed',
        mediaType: 'text/plain; charset=utf-8',
        body: unique.size ? `${[...unique.keys()].sort().join('\n')}\n` : '',
        metadata: {
          tool,
          rawResults: parsed.rawResults,
          validResults: valid.length,
          uniqueResults: unique.size,
        },
      });
      artifactIds.push(parsedArtifact.id);
      for (const item of valid) {
        const stored = this.database.upsertReconAsset({
          engagementId: run.engagementId,
          sessionId: run.sessionId,
          runId: run.id,
          value: item.asset.value,
          normalizedValue: item.asset.normalizedValue,
          type: item.asset.type,
          inScope: item.asset.inScope,
          activeTestingAllowed: item.asset.activeTestingAllowed,
          source: {
            tool,
            toolRunId: toolRun.id,
            artifactId: parsedArtifact.id,
            rawValue: item.raw,
          },
        });
        if (stored.sourceCreated) {
          this.publish(run, stored.created ? 'recon.asset.discovered' : 'recon.asset.updated', {
            runId: run.id,
            assetId: stored.asset.id,
            value: stored.asset.normalizedValue,
            tool,
            inScope: stored.asset.inScope,
          });
        }
      }
      const status = terminalStatus(result, signal);
      const error = status === 'completed' ? undefined : scannerError(tool, result);
      const metadata = await this.saveReconArtifact(run, toolRun.id, tool, {
        role: 'metadata',
        filename: 'metadata.json',
        kind: 'recon-tool-metadata',
        mediaType: 'application/json',
        body: `${JSON.stringify(
          {
            tool,
            actionName,
            status,
            exitCode: result.exitCode,
            rawResults: parsed.rawResults,
            validResults: valid.length,
            uniqueResults: unique.size,
            malformedResults: Math.max(0, parsed.rawResults - valid.length),
            error,
          },
          null,
          2,
        )}\n`,
        metadata: { tool, status },
      });
      artifactIds.push(metadata.id);
      this.transitionTool(run, toolRun.id, status, {
        exitCode: result.exitCode,
        rawResults: parsed.rawResults,
        validResults: valid.length,
        uniqueResults: unique.size,
        artifactIds,
        error,
        partialStdout: status === 'completed' ? undefined : result.stdout,
        partialStderr: status === 'completed' ? undefined : result.stderr,
        metadata: { malformedResults: Math.max(0, parsed.rawResults - valid.length) },
      });
      if (status !== 'completed' && unique.size > 0) {
        this.publish(run, 'recon.tool.partial', {
          runId: run.id,
          toolRunId: toolRun.id,
          tool,
          status,
          uniqueResults: unique.size,
          artifactIds,
        });
        this.publish(run, 'recon.run.partial', {
          runId: run.id,
          toolRunId: toolRun.id,
          tool,
          uniqueResults: unique.size,
        });
      }
      return {
        status,
        parsedArtifactId: parsedArtifact.id,
        rawResults: parsed.rawResults,
        validResults: valid.length,
        uniqueResults: unique.size,
        error,
      };
    } catch (error) {
      const message = safeError(error);
      const status = signal.aborted ? 'cancelled' : 'failed';
      this.transitionTool(run, toolRun.id, status, {
        exitCode: result?.exitCode,
        artifactIds,
        error: message,
        partialStdout: result?.stdout,
        partialStderr: result?.stderr,
      });
      return {
        status,
        rawResults: 0,
        validResults: 0,
        uniqueResults: 0,
        error: message,
      };
    }
  }

  private async saveCombined(run: ReconRunRecord): Promise<CombinedOutcome> {
    const assets = this.database
      .listReconAssets(run.sessionId, run.id)
      .filter((asset) => asset.type === 'domain' || asset.type === 'subdomain')
      .sort((a, b) => a.normalizedValue.localeCompare(b.normalizedValue));
    const toolRuns = this.database
      .listReconToolRuns(run.id)
      .filter((toolRun) => !['dnsx', 'httpx'].includes(toolRun.tool));
    const withSources = assets.map((asset) => ({
      domain: asset.normalizedValue,
      sources: [...new Set(asset.sources.map((source) => source.tool))].sort(),
      inScope: asset.inScope,
    }));
    const duplicateRows = assets
      .filter((asset) => asset.sources.length > 1)
      .map((asset) => ({
        domain: asset.normalizedValue,
        occurrences: asset.sources.length,
        sources: asset.sources.map((source) => ({
          tool: source.tool,
          toolRunId: source.toolRunId,
          rawValue: source.rawValue,
        })),
      }));
    const rawResults = toolRuns.reduce((sum, toolRun) => sum + toolRun.rawResults, 0);
    const validResults = toolRuns.reduce((sum, toolRun) => sum + toolRun.validResults, 0);
    const summary: CombinedSummary = {
      toolsExecuted: toolRuns.filter((toolRun) => toolRun.tool !== 'scope').length,
      rawResults,
      validResults,
      uniqueDomains: assets.length,
      inScopeDomains: assets.filter((asset) => asset.inScope).length,
      outOfScopeDomains: assets.filter((asset) => !asset.inScope).length,
      duplicatesRemoved: Math.max(0, validResults - assets.length),
    };
    const text = await this.saveReconArtifact(run, undefined, 'combined', {
      role: 'combined',
      filename: 'all-domains.txt',
      kind: 'recon-combined-domains',
      mediaType: 'text/plain; charset=utf-8',
      body: assets.length ? `${assets.map((asset) => asset.normalizedValue).join('\n')}\n` : '',
      metadata: { ...summary },
    });
    await this.saveReconArtifact(run, undefined, 'combined', {
      role: 'combined',
      filename: 'all-domains-with-sources.json',
      kind: 'recon-combined-sources',
      mediaType: 'application/json',
      body: `${JSON.stringify(withSources, null, 2)}\n`,
      metadata: { ...summary },
    });
    await this.saveReconArtifact(run, undefined, 'combined', {
      role: 'combined',
      filename: 'duplicates.json',
      kind: 'recon-duplicates',
      mediaType: 'application/json',
      body: `${JSON.stringify(duplicateRows, null, 2)}\n`,
      metadata: { duplicatesRemoved: summary.duplicatesRemoved },
    });
    this.publish(run, 'recon.assets.merged', { runId: run.id, ...summary });
    this.publish(run, 'recon.combined.saved', {
      runId: run.id,
      artifactId: text.id,
      ...summary,
    });
    return {
      summary,
      inScopeDomains: assets
        .filter((asset) => asset.inScope && asset.activeTestingAllowed)
        .map((asset) => asset.normalizedValue),
    };
  }

  private async executeDnsx(
    run: ReconRunRecord,
    scope: ScopeDefinition,
    targets: string[],
    signal: AbortSignal,
  ): Promise<ObservationToolOutcome> {
    const toolRun = this.queueTool(run, 'dnsx', 'dns_resolution');
    const artifactIds: string[] = [];
    let result: ScannerResult | undefined;
    try {
      this.transitionTool(run, toolRun.id, 'running');
      result = await this.runner.dnsx(
        targets.slice(0, scope.limits.maxUrlsPerHost),
        scope.limits,
        signal,
      );
      this.transitionTool(run, toolRun.id, 'saving', { exitCode: result.exitCode });
      const raw = await this.saveReconArtifact(run, toolRun.id, 'dnsx', {
        role: 'raw',
        filename: 'raw.jsonl',
        kind: 'recon-dnsx-raw',
        mediaType: 'application/x-ndjson',
        body: withFinalNewline(result.stdout),
        metadata: { tool: 'dnsx', targets: targets.length },
      });
      artifactIds.push(raw.id);
      const lines = nonEmptyLines(result.stdout);
      const rows = lines.flatMap((line) => {
        try {
          const row = JSON.parse(line) as unknown;
          return isRecord(row) ? [row] : [];
        } catch {
          return [];
        }
      });
      const parsed = await this.saveReconArtifact(run, toolRun.id, 'dnsx', {
        role: 'parsed',
        filename: 'parsed.jsonl',
        kind: 'recon-dnsx-parsed',
        mediaType: 'application/x-ndjson',
        body: rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
        metadata: { rawResults: lines.length, validResults: rows.length },
      });
      artifactIds.push(parsed.id);
      for (const row of rows) {
        const host = stringField(row, 'host') ?? stringField(row, 'input');
        if (!host) continue;
        let normalized: string;
        try {
          normalized = normalizeReconValue(host, scope).host;
        } catch {
          continue;
        }
        const asset = this.database.findReconAsset(run.id, normalized);
        if (!asset) continue;
        const addresses = [...stringArrayField(row, 'a'), ...stringArrayField(row, 'aaaa')];
        const cname = stringField(row, 'cname') ?? stringArrayField(row, 'cname').at(0);
        this.database.updateReconAssetDns(asset.id, {
          resolved: addresses.length > 0 || Boolean(cname),
          addresses: [...new Set(addresses)],
          cname,
        });
      }
      const status = terminalStatus(result, signal);
      const error = status === 'completed' ? undefined : scannerError('dnsx', result);
      const metadata = await this.saveReconArtifact(run, toolRun.id, 'dnsx', {
        role: 'metadata',
        filename: 'metadata.json',
        kind: 'recon-tool-metadata',
        mediaType: 'application/json',
        body: `${JSON.stringify(
          {
            tool: 'dnsx',
            status,
            exitCode: result.exitCode,
            targets: targets.length,
            rawResults: lines.length,
            validResults: rows.length,
            malformedResults: lines.length - rows.length,
            error,
          },
          null,
          2,
        )}\n`,
      });
      artifactIds.push(metadata.id);
      this.finishObservationTool(run, toolRun.id, 'dnsx', status, result, artifactIds, {
        rawResults: lines.length,
        validResults: rows.length,
        uniqueResults: new Set(rows.map((row) => stringField(row, 'host')).filter(Boolean)).size,
        error,
      });
      return {
        status,
        parsedArtifactId: parsed.id,
        validResults: rows.length,
        error,
      };
    } catch (error) {
      const message = safeError(error);
      const status = signal.aborted ? 'cancelled' : 'failed';
      this.finishObservationTool(run, toolRun.id, 'dnsx', status, result, artifactIds, {
        rawResults: 0,
        validResults: 0,
        uniqueResults: 0,
        error: message,
      });
      return { status, validResults: 0, error: message };
    }
  }

  private async executeHttpx(
    run: ReconRunRecord,
    scope: ScopeDefinition,
    targets: string[],
    signal: AbortSignal,
  ): Promise<HttpxOutcome> {
    const toolRun = this.queueTool(run, 'httpx', 'http_probe');
    const artifactIds: string[] = [];
    let result: ScannerResult | undefined;
    try {
      this.transitionTool(run, toolRun.id, 'running');
      const selected = targets.slice(0, scope.limits.maxUrlsPerHost);
      this.publish(run, 'recon.httpx.started', {
        runId: run.id,
        toolRunId: toolRun.id,
        targets: selected.length,
      });
      result = await this.runner.httpx(
        selected,
        {
          requestsPerSecond: scope.limits.requestsPerSecond,
          concurrency: scope.limits.concurrency,
          followRedirects: false,
        },
        scope.limits,
        signal,
      );
      this.transitionTool(run, toolRun.id, 'saving', { exitCode: result.exitCode });
      const lines = nonEmptyLines(result.stdout);
      const parsedRows = lines.flatMap((line) => {
        try {
          const row = JSON.parse(line) as unknown;
          return isRecord(row) ? [{ row, line }] : [];
        } catch {
          return [];
        }
      });
      const liveUrls = new Set<string>();
      const observedInputs = new Set<string>();
      const structured: Record<string, unknown>[] = [];
      for (const { row } of parsedRows) {
        const input = stringField(row, 'input') ?? stringField(row, 'host') ?? '';
        const url = stringField(row, 'url') ?? stringField(row, 'final_url') ?? '';
        if (!url) continue;
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url);
        } catch {
          continue;
        }
        const host = parsedUrl.hostname.toLowerCase().replace(/\.$/, '');
        const inputHost = extractHost(input) ?? host;
        const asset = this.database.findReconAsset(run.id, inputHost);
        if (!asset || !asset.inScope) continue;
        const technologies = [
          ...stringArrayField(row, 'tech'),
          ...stringArrayField(row, 'technologies'),
        ];
        const statusCode = numberField(row, 'status_code');
        const finalUrl = stringField(row, 'final_url') ?? url;
        const record = this.database.addReconHttpResult({
          assetId: asset.id,
          runId: run.id,
          toolRunId: toolRun.id,
          input: input || asset.normalizedValue,
          url,
          host,
          port: numberField(row, 'port') ?? effectivePort(parsedUrl),
          scheme: stringField(row, 'scheme') ?? parsedUrl.protocol.replace(':', ''),
          statusCode,
          contentLength: numberField(row, 'content_length'),
          title: stringField(row, 'title'),
          technologies: [...new Set(technologies)],
          webServer: stringField(row, 'webserver') ?? stringField(row, 'web_server'),
          contentType: stringField(row, 'content_type'),
          finalUrl,
          ip: stringField(row, 'ip'),
          cname: stringField(row, 'cname') ?? stringArrayField(row, 'cname').at(0),
          responseTime:
            stringField(row, 'time') ??
            stringField(row, 'response_time') ??
            numberField(row, 'time')?.toString(),
          raw: row,
        });
        structured.push({
          input: record.input,
          url: record.url,
          host: record.host,
          port: record.port,
          scheme: record.scheme,
          status_code: record.statusCode,
          content_length: record.contentLength,
          title: record.title,
          technologies: record.technologies,
          web_server: record.webServer,
          content_type: record.contentType,
          final_url: record.finalUrl,
          ip: record.ip,
          cname: record.cname,
          response_time: record.responseTime,
          asset_id: asset.id,
          discovery_tools: [...new Set(asset.sources.map((source) => source.tool))],
        });
        liveUrls.add(url);
        observedInputs.add(inputHost);
        this.database.updateReconAssetHttp(asset.id, {
          probed: true,
          live: true,
          finalUrl,
          statusCode,
          title: record.title,
          technologies: record.technologies,
          contentType: record.contentType,
          webServer: record.webServer,
        });
      }
      const failedInputs = selected.filter((target) => !observedInputs.has(target));
      const jsonl = await this.saveReconArtifact(run, toolRun.id, 'httpx', {
        role: 'httpx',
        filename: 'live-hosts.jsonl',
        kind: 'recon-httpx-jsonl',
        mediaType: 'application/x-ndjson',
        body: structured.length
          ? `${structured.map((row) => JSON.stringify(row)).join('\n')}\n`
          : '',
        metadata: { tool: 'httpx', targets: selected.length, live: liveUrls.size },
      });
      artifactIds.push(jsonl.id);
      const liveText = await this.saveReconArtifact(run, toolRun.id, 'httpx', {
        role: 'httpx',
        filename: 'live-hosts.txt',
        kind: 'recon-httpx-live-hosts',
        mediaType: 'text/plain; charset=utf-8',
        body: liveUrls.size ? `${[...liveUrls].sort().join('\n')}\n` : '',
        metadata: { tool: 'httpx', live: liveUrls.size },
      });
      artifactIds.push(liveText.id);
      const failed = await this.saveReconArtifact(run, toolRun.id, 'httpx', {
        role: 'failed-inputs',
        filename: 'failed-inputs.txt',
        kind: 'recon-httpx-failed-inputs',
        mediaType: 'text/plain; charset=utf-8',
        body: failedInputs.length ? `${failedInputs.join('\n')}\n` : '',
        metadata: { tool: 'httpx', failedInputs: failedInputs.length },
      });
      artifactIds.push(failed.id);
      const status = terminalStatus(result, signal);
      const error = status === 'completed' ? undefined : scannerError('httpx', result);
      const summary = await this.saveReconArtifact(run, toolRun.id, 'httpx', {
        role: 'metadata',
        filename: 'summary.json',
        kind: 'recon-httpx-summary',
        mediaType: 'application/json',
        body: `${JSON.stringify(
          {
            tool: 'httpx',
            status,
            exitCode: result.exitCode,
            inputs: selected.length,
            rawResults: lines.length,
            validResults: structured.length,
            uniqueLiveHosts: liveUrls.size,
            failedInputs: failedInputs.length,
            malformedResults: lines.length - parsedRows.length,
            error,
          },
          null,
          2,
        )}\n`,
      });
      artifactIds.push(summary.id);
      this.finishObservationTool(run, toolRun.id, 'httpx', status, result, artifactIds, {
        rawResults: lines.length,
        validResults: structured.length,
        uniqueResults: liveUrls.size,
        error,
      });
      this.publish(run, 'recon.httpx.completed', {
        runId: run.id,
        toolRunId: toolRun.id,
        status,
        liveHosts: liveUrls.size,
        failedInputs: failedInputs.length,
        artifactIds,
      });
      return {
        status,
        liveTextArtifactId: liveText.id,
        validResults: structured.length,
        failedInputs: failedInputs.length,
        error,
      };
    } catch (error) {
      const message = safeError(error);
      const status = signal.aborted ? 'cancelled' : 'failed';
      this.finishObservationTool(run, toolRun.id, 'httpx', status, result, artifactIds, {
        rawResults: 0,
        validResults: 0,
        uniqueResults: 0,
        error: message,
      });
      return { status, validResults: 0, failedInputs: targets.length, error: message };
    }
  }

  private queueTool(run: ReconRunRecord, tool: string, actionName: string): ReconToolRunRecord {
    const toolRun = this.database.createReconToolRun({
      reconRunId: run.id,
      engagementId: run.engagementId,
      sessionId: run.sessionId,
      tool,
      actionName,
    });
    this.publish(run, 'recon.tool.queued', {
      runId: run.id,
      toolRunId: toolRun.id,
      tool,
      actionName,
    });
    return toolRun;
  }

  private transitionTool(
    run: ReconRunRecord,
    toolRunId: string,
    status: ReconToolRunRecord['status'],
    input: Parameters<WebDatabase['updateReconToolRun']>[2] = {},
  ): ReconToolRunRecord {
    const updated = this.database.updateReconToolRun(toolRunId, status, {
      ...input,
      partialStdout: input.partialStdout?.slice(0, 64 * 1024),
      partialStderr: input.partialStderr?.slice(0, 64 * 1024),
    });
    this.publish(run, `recon.tool.${status}`, {
      runId: run.id,
      toolRunId,
      tool: updated.tool,
      status,
      exitCode: updated.exitCode,
      rawResults: updated.rawResults,
      validResults: updated.validResults,
      uniqueResults: updated.uniqueResults,
      artifactIds: updated.artifactIds,
      error: updated.error,
    });
    return updated;
  }

  private finishObservationTool(
    run: ReconRunRecord,
    toolRunId: string,
    tool: string,
    status: ReconToolRunRecord['status'],
    result: ScannerResult | undefined,
    artifactIds: string[],
    metrics: {
      rawResults: number;
      validResults: number;
      uniqueResults: number;
      error?: string;
    },
  ): void {
    this.transitionTool(run, toolRunId, status, {
      exitCode: result?.exitCode,
      ...metrics,
      artifactIds,
      partialStdout: status === 'completed' ? undefined : result?.stdout,
      partialStderr: status === 'completed' ? undefined : result?.stderr,
    });
    if (status !== 'completed' && metrics.validResults > 0) {
      this.publish(run, 'recon.tool.partial', {
        runId: run.id,
        toolRunId,
        tool,
        status,
        validResults: metrics.validResults,
        artifactIds,
      });
    }
  }

  private async saveReconArtifact(
    run: ReconRunRecord,
    toolRunId: string | undefined,
    directory: string,
    input: {
      role: Parameters<WebDatabase['linkReconArtifact']>[0]['role'];
      filename: string;
      kind: string;
      mediaType: string;
      body: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ArtifactRecord> {
    const artifact = await this.artifacts.save({
      engagementId: run.engagementId,
      sessionId: run.sessionId,
      kind: input.kind,
      filename: input.filename,
      mediaType: input.mediaType,
      body: input.body,
      metadata: { ...input.metadata, runId: run.id, toolRunId, tool: directory },
      directory: ['engagements', run.engagementId, 'recon', run.id, directory],
    });
    this.database.linkReconArtifact({
      runId: run.id,
      toolRunId,
      artifactId: artifact.id,
      role: input.role,
    });
    this.publish(run, 'recon.artifact.saved', {
      runId: run.id,
      toolRunId,
      tool: directory,
      artifactId: artifact.id,
      role: input.role,
      filename: artifact.filename,
      sha256: artifact.sha256,
    });
    return artifact;
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

interface ParsedValues {
  rawResults: number;
  values: string[];
}

interface DomainToolOutcome {
  status: ReconToolRunRecord['status'];
  parsedArtifactId?: string;
  rawResults: number;
  validResults: number;
  uniqueResults: number;
  error?: string;
}

interface ObservationToolOutcome {
  status: ReconToolRunRecord['status'];
  parsedArtifactId?: string;
  validResults: number;
  error?: string;
}

interface HttpxOutcome extends ObservationToolOutcome {
  liveTextArtifactId?: string;
  failedInputs: number;
}

interface CombinedSummary {
  toolsExecuted: number;
  rawResults: number;
  validResults: number;
  uniqueDomains: number;
  inScopeDomains: number;
  outOfScopeDomains: number;
  duplicatesRemoved: number;
}

interface CombinedOutcome {
  summary: CombinedSummary;
  inScopeDomains: string[];
}

function parseLineValues(stdout: string): ParsedValues {
  const values = nonEmptyLines(stdout);
  return { rawResults: values.length, values };
}

function parseCrtshValues(stdout: string): ParsedValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { rawResults: nonEmptyLines(stdout).length, values: [] };
  }
  if (!Array.isArray(parsed)) return { rawResults: 1, values: [] };
  const values = parsed.flatMap((row) => {
    if (!isRecord(row)) return [];
    const names = [stringField(row, 'name_value'), stringField(row, 'common_name')].filter(
      (value): value is string => Boolean(value),
    );
    return names
      .flatMap((value) => value.split(/\r?\n/).map((entry) => entry.trim()))
      .filter(Boolean);
  });
  return { rawResults: values.length, values };
}

async function executeForRoots(
  roots: string[],
  execute: (root: string) => Promise<ScannerResult>,
  signal: AbortSignal,
  merge: (results: ScannerResult[]) => ScannerResult = mergeScannerResults,
): Promise<ScannerResult> {
  const results: ScannerResult[] = [];
  for (const root of roots) {
    if (signal.aborted) break;
    try {
      results.push(await execute(root));
    } catch (error) {
      results.push({
        stdout: '',
        stderr: safeError(error),
        exitCode: 1,
        profile: 'safe',
        image: 'unknown',
        termination: signal.aborted ? 'cancelled' : 'start_failed',
        error: safeError(error),
      });
    }
  }
  if (results.length === 0)
    return {
      stdout: '',
      stderr: signal.aborted ? 'cancelled before execution' : 'no root targets',
      exitCode: 1,
      profile: 'safe',
      image: 'unknown',
      termination: signal.aborted ? 'cancelled' : 'start_failed',
    };
  return merge(results);
}

function mergeScannerResults(results: ScannerResult[]): ScannerResult {
  const failed = results.find((result) => result.exitCode !== 0 || result.termination !== 'exit');
  return {
    stdout: results
      .map((result) => result.stdout)
      .filter(Boolean)
      .join('\n'),
    stderr: results
      .map((result) => result.stderr)
      .filter(Boolean)
      .join('\n'),
    exitCode: failed?.exitCode ?? 0,
    profile: results[0]?.profile ?? 'safe',
    image: results[0]?.image ?? 'unknown',
    termination: failed?.termination ?? 'exit',
    error: failed?.error,
  };
}

function mergeCrtshResults(results: ScannerResult[]): ScannerResult {
  const merged = mergeScannerResults(results);
  const rows = results.flatMap((result) => {
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  return { ...merged, stdout: JSON.stringify(rows) };
}

function successfulResult(stdout: string): ScannerResult {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    profile: 'safe',
    image: 'server',
    termination: 'exit',
  };
}

function terminalStatus(result: ScannerResult, signal: AbortSignal): ReconToolRunRecord['status'] {
  if (signal.aborted || result.termination === 'cancelled') return 'cancelled';
  if (result.termination === 'timed_out') return 'timed_out';
  return result.exitCode === 0 ? 'completed' : 'failed';
}

function scannerError(tool: string, result: ScannerResult): string {
  return clean(
    result.error ?? `${tool} exited ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ''}`,
  ).slice(0, 1000);
}

function nonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function withFinalNewline(value: string): string {
  return value ? `${value.replace(/\s+$/, '')}\n` : '';
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  if (typeof value === 'string') return value ? [value] : [];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item))
    : [];
}

function extractHost(value: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    try {
      return normalizeHost(value);
    } catch {
      return undefined;
    }
  }
}

function effectivePort(url: URL): number | undefined {
  if (url.port) return Number(url.port);
  if (url.protocol === 'https:') return 443;
  if (url.protocol === 'http:') return 80;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
