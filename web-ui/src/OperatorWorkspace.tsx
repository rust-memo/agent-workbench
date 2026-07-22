import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActionProposal,
  Artifact,
  CoverageResponse,
  Engagement,
  Finding,
  ReconInsight,
  ReconRun,
  RuntimeEvent,
  Session,
  WorkbenchStatus,
} from './api';

export type OperatorPage = 'run' | 'output';
type OutputFilter = 'all' | 'tools' | 'ai';
type ToolActivity = { id: string; name: string; detail: string; status: string };

export function OperatorWorkspace({
  engagement,
  session,
  run,
  profile,
  events,
  artifacts,
  proposals,
  findings,
  coverage,
  status,
  analyzing,
  policyBusy,
  page,
  onPageChange,
  onProfile,
  onStart,
  onCancel,
  onAnalyze,
  onApprove,
  onReject,
  onLoadSkill,
  onTogglePassive,
  onToggleSubdomains,
}: {
  engagement?: Engagement;
  session?: Session;
  run?: ReconRun;
  profile: ReconRun['profile'];
  events: RuntimeEvent[];
  artifacts: Artifact[];
  proposals: ActionProposal[];
  findings: Finding[];
  coverage: CoverageResponse;
  status: WorkbenchStatus | null;
  analyzing: boolean;
  policyBusy: boolean;
  page: OperatorPage;
  onPageChange: (page: OperatorPage) => void;
  onProfile: (profile: ReconRun['profile']) => void;
  onStart: () => void;
  onCancel: () => void;
  onAnalyze: () => void;
  onApprove: (proposal: ActionProposal) => void;
  onReject: (proposal: ActionProposal) => void;
  onLoadSkill: (name: string, target?: string) => void;
  onTogglePassive: () => void;
  onToggleSubdomains: () => void;
}): React.ReactElement {
  const [outputFilter, setOutputFilter] = useState<OutputFilter>('all');
  const outputRef = useRef<HTMLDivElement>(null);
  const running =
    session?.state === 'running' || run?.status === 'running' || run?.status === 'queued';
  const pending = proposals.filter((proposal) => proposal.status === 'pending');
  const activity = useMemo(
    () => buildToolActivity(run, proposals, events),
    [run, proposals, events],
  );
  const outputEvents = useMemo(() => filterOutput(events, outputFilter), [events, outputFilter]);
  const aiText = useMemo(() => latestAiText(events), [events]);
  const recommendations = (run?.insights ?? []).filter(
    (insight) => insight.status === 'new' || insight.status === 'accepted',
  );
  const operation = currentOperation(session, run, proposals);
  const steps = run?.steps ?? defaultSteps();
  const readyScanners = Object.values(status?.scanners ?? {}).filter(
    (scanner) => scanner.available && scanner.enabled,
  ).length;

  useEffect(() => {
    if (page !== 'output') return;
    const node = outputRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  });

  return (
    <section className="operator-v2">
      <header className="operator-v2-bar">
        <div className="operator-overview-v3">
          <OverviewCard
            icon="◎"
            label="Target"
            value={engagement?.scope.allowedHosts[0] ?? 'No target selected'}
            detail={`${engagement?.scope.allowedHosts.length ?? 0} authorized host rules`}
          />
          <OverviewCard
            icon="⌾"
            label="Mode"
            value={engagement?.mode ?? 'Not configured'}
            detail={running ? 'Execution in progress' : 'Approval policies active'}
            tone="green"
          />
          <OverviewCard
            icon="✣"
            label="Provider / Model"
            value={
              status?.providers.find((item) => item.provider === session?.provider)?.label ??
              session?.provider ??
              'No provider'
            }
            detail={session?.model ?? 'No model selected'}
            tone="cyan"
          />
          <OverviewCard
            icon="♢"
            label="Scanner health"
            value={readyScanners > 0 ? 'Healthy' : 'Needs attention'}
            detail={`${readyScanners} scanners ready`}
            tone={readyScanners > 0 ? 'green' : 'amber'}
          />
        </div>

        <div className="operator-commandbar-v3">
          <div className="operator-v2-scope">
            <span className="eyebrow">AUTHORIZED SCOPE · v{engagement?.scope.version ?? 0}</span>
            <strong>{engagement?.scope.allowedHosts.join(', ') ?? 'No scope selected'}</strong>
          </div>

          <nav className="operator-v2-pages" aria-label="AI Operator pages">
            <button
              type="button"
              className={page === 'run' ? 'active' : ''}
              onClick={() => onPageChange('run')}
            >
              <span>Run Control</span>
              <small>{running ? 'live' : `${run?.progress ?? 0}%`}</small>
            </button>
            <button
              type="button"
              className={page === 'output' ? 'active' : ''}
              onClick={() => onPageChange('output')}
            >
              <span>Output & Evidence</span>
              <small>{events.length + artifacts.length}</small>
            </button>
          </nav>

          <div className="operator-v2-controls">
            <select
              aria-label="Finder profile"
              value={profile}
              disabled={!session || running}
              onChange={(event) => onProfile(event.target.value as ReconRun['profile'])}
            >
              <option value="quick">Quick</option>
              <option value="standard">Standard</option>
              <option value="advanced">Advanced</option>
            </select>
            {running ? (
              <button type="button" className="stop" onClick={onCancel}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="start"
                onClick={onStart}
                disabled={!session || engagement?.mode !== 'RECON'}
              >
                Start finder
              </button>
            )}
          </div>
        </div>
      </header>

      {page === 'run' ? (
        <RunPage
          engagement={engagement}
          session={session}
          run={run}
          operation={operation}
          running={running}
          steps={steps}
          activity={activity}
          pending={pending}
          aiText={aiText}
          recommendations={recommendations}
          artifacts={artifacts}
          findings={findings}
          readyScanners={readyScanners}
          analyzing={analyzing}
          policyBusy={policyBusy}
          onStart={onStart}
          onAnalyze={onAnalyze}
          onApprove={onApprove}
          onReject={onReject}
          onLoadSkill={onLoadSkill}
          onTogglePassive={onTogglePassive}
          onToggleSubdomains={onToggleSubdomains}
          onOpenOutput={() => onPageChange('output')}
        />
      ) : (
        <OutputPage
          events={outputEvents}
          outputFilter={outputFilter}
          setOutputFilter={setOutputFilter}
          outputRef={outputRef}
          activity={activity}
          artifacts={artifacts}
          findings={findings}
          coverage={coverage}
          status={status}
          pending={pending}
          onApprove={onApprove}
          onReject={onReject}
        />
      )}
    </section>
  );
}

function OverviewCard({
  icon,
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  icon: string;
  label: string;
  value: string;
  detail: string;
  tone?: 'neutral' | 'green' | 'cyan' | 'amber';
}): React.ReactElement {
  return (
    <article className={`overview-card-v3 ${tone}`}>
      <span className="overview-icon-v3" aria-hidden="true">
        {icon}
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function RunPage({
  engagement,
  session,
  run,
  operation,
  running,
  steps,
  activity,
  pending,
  aiText,
  recommendations,
  artifacts,
  findings,
  readyScanners,
  analyzing,
  policyBusy,
  onStart,
  onAnalyze,
  onApprove,
  onReject,
  onLoadSkill,
  onTogglePassive,
  onToggleSubdomains,
  onOpenOutput,
}: {
  engagement?: Engagement;
  session?: Session;
  run?: ReconRun;
  operation: { label: string; detail: string; kind: string };
  running: boolean;
  steps: ReconRun['steps'];
  activity: ToolActivity[];
  pending: ActionProposal[];
  aiText: string;
  recommendations: ReconInsight[];
  artifacts: Artifact[];
  findings: Finding[];
  readyScanners: number;
  analyzing: boolean;
  policyBusy: boolean;
  onStart: () => void;
  onAnalyze: () => void;
  onApprove: (proposal: ActionProposal) => void;
  onReject: (proposal: ActionProposal) => void;
  onLoadSkill: (name: string, target?: string) => void;
  onTogglePassive: () => void;
  onToggleSubdomains: () => void;
  onOpenOutput: () => void;
}): React.ReactElement {
  const nextActivity = activity.filter((item) => !['completed', 'skipped'].includes(item.status));
  const passiveEnabled = engagement?.scope.allowThirdPartyPassiveSources ?? false;
  const subdomainsEnabled =
    engagement?.scope.allowedHosts.some((host) => host.startsWith('*.')) ?? false;
  return (
    <div className="run-page-v2">
      <section className={`run-hero-v2 ${operation.kind}`}>
        <div className="run-state-v2">
          <span className={`run-orb ${running ? 'live' : ''}`} />
          <div>
            <span className="eyebrow">{running ? 'RUNNING NOW' : 'CURRENT STATE'}</span>
            <h2>{operation.label}</h2>
            <p>{operation.detail}</p>
          </div>
        </div>
        <div className="run-progress-v2">
          <div>
            <strong>{run?.progress ?? 0}%</strong>
            <span>complete</span>
          </div>
          <div className="progress-line">
            <i style={{ width: `${run?.progress ?? 0}%` }} />
          </div>
        </div>
        <dl className="run-facts-v2">
          <div>
            <dt>Evidence</dt>
            <dd>{artifacts.length}</dd>
          </div>
          <div>
            <dt>Signals</dt>
            <dd>{findings.length}</dd>
          </div>
          <div>
            <dt>Scanners</dt>
            <dd>{readyScanners} ready</dd>
          </div>
        </dl>
      </section>

      <section className="pipeline-v2" aria-label="Recon pipeline">
        {steps.map((step, index) => (
          <article className={step.status} key={step.id}>
            <span>{step.status === 'completed' ? '✓' : String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>{toolForStep(step.key)}</strong>
              <small>{step.detail ?? step.label}</small>
            </div>
          </article>
        ))}
      </section>

      {!passiveEnabled && (
        <section className="quiet-notice warning">
          <div>
            <strong>Subfinder is disabled</strong>
            <p>Passive discovery will be skipped until you approve third-party passive sources.</p>
          </div>
          <button type="button" onClick={onStart} disabled={!session || running}>
            Enable & start
          </button>
        </section>
      )}

      <div className="run-columns-v2">
        <section className="quiet-card execution-card-v2">
          <header>
            <div>
              <span className="eyebrow">EXECUTION</span>
              <h3>What happens next</h3>
            </div>
            <button type="button" onClick={onOpenOutput}>
              Open live output →
            </button>
          </header>
          <div className="next-actions-v2">
            {(nextActivity.length ? nextActivity : activity.slice(-4)).slice(0, 6).map((item) => (
              <article className={item.status} key={item.id}>
                <i />
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.detail}</small>
                </div>
                <span>{item.status.replace('_', ' ')}</span>
              </article>
            ))}
            {activity.length === 0 && (
              <Empty text="Start a scoped run. Only the active and next steps will stay on this page." />
            )}
          </div>
          <footer className="policy-row-v2">
            <button
              type="button"
              className={passiveEnabled ? 'enabled' : ''}
              onClick={onTogglePassive}
              disabled={!engagement || running || policyBusy}
            >
              Subfinder {passiveEnabled ? 'enabled' : 'disabled'}
            </button>
            <button
              type="button"
              className={subdomainsEnabled ? 'enabled' : ''}
              onClick={onToggleSubdomains}
              disabled={!engagement || running || policyBusy}
            >
              Subdomains {subdomainsEnabled ? 'in scope' : 'discovery only'}
            </button>
          </footer>
        </section>

        <section className="quiet-card ai-brief-v2">
          <header>
            <div>
              <span className="eyebrow">AI BRIEF</span>
              <h3>Assessment & recommendations</h3>
            </div>
            <button
              type="button"
              onClick={onAnalyze}
              disabled={!session || running || analyzing || (!run && artifacts.length === 0)}
            >
              {analyzing ? 'Dispatching…' : 'Analyze evidence'}
            </button>
          </header>
          <pre>
            {aiText ||
              'When evidence is ready, the selected AI will summarize what ran, what was observed, and the safest high-value next action.'}
          </pre>
          <div className="recommendations-v2">
            {recommendations.slice(0, 3).map((insight) => (
              <Recommendation key={insight.id} insight={insight} onLoadSkill={onLoadSkill} />
            ))}
            {recommendations.length === 0 && <Empty text="No recommendations yet." />}
          </div>
        </section>
      </div>

      {pending[0] && (
        <section className="permission-bar-v2">
          <div>
            <span>PERMISSION REQUIRED · {pending[0].risk}</span>
            <strong>{pending[0].action}</strong>
            <p>{pending[0].reason}</p>
          </div>
          <div>
            <button
              type="button"
              className="decline"
              onClick={() => onReject(pending[0] as ActionProposal)}
            >
              Decline
            </button>
            <button
              type="button"
              className="approve"
              onClick={() => onApprove(pending[0] as ActionProposal)}
            >
              Review & run once
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function OutputPage({
  events,
  outputFilter,
  setOutputFilter,
  outputRef,
  activity,
  artifacts,
  findings,
  coverage,
  status,
  pending,
  onApprove,
  onReject,
}: {
  events: RuntimeEvent[];
  outputFilter: OutputFilter;
  setOutputFilter: (filter: OutputFilter) => void;
  outputRef: React.RefObject<HTMLDivElement | null>;
  activity: ToolActivity[];
  artifacts: Artifact[];
  findings: Finding[];
  coverage: CoverageResponse;
  status: WorkbenchStatus | null;
  pending: ActionProposal[];
  onApprove: (proposal: ActionProposal) => void;
  onReject: (proposal: ActionProposal) => void;
}): React.ReactElement {
  const coverageTotal = coverage.summary.total ?? 0;
  const coverageDone = Math.max(0, coverageTotal - (coverage.summary.untested ?? 0));
  const coveragePercent = coverageTotal > 0 ? Math.round((coverageDone / coverageTotal) * 100) : 0;
  const severityCounts = findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    return counts;
  }, {});
  return (
    <div className="output-page-v2">
      <section className="output-console-v2">
        <header>
          <div>
            <span className="eyebrow">SESSION TRANSCRIPT</span>
            <h2>Live operation stream</h2>
          </div>
          <div className="output-console-actions-v3">
            <span className="streaming-indicator-v3">
              <i /> Streaming
            </span>
            <div className="output-filters-v2">
              {(['all', 'tools', 'ai'] as const).map((filter) => (
                <button
                  type="button"
                  className={outputFilter === filter ? 'active' : ''}
                  onClick={() => setOutputFilter(filter)}
                  key={filter}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="output-stream-v2" ref={outputRef} role="log" aria-live="polite">
          {events.slice(-200).map((event) => (
            <article className={eventTone(event)} key={event.eventId}>
              <div>
                <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                <span>{event.type}</span>
              </div>
              <pre>{operatorEventText(event)}</pre>
            </article>
          ))}
          {events.length === 0 && <Empty text="No output for this filter yet." />}
        </div>
      </section>

      <aside className="evidence-panel-v2">
        <header>
          <div>
            <span className="eyebrow">MISSION DETAILS</span>
            <h2>Evidence & control</h2>
          </div>
          <strong>{artifacts.length}</strong>
        </header>
        {pending[0] && (
          <section className="output-approval-v3">
            <header>
              <strong>Approval required</strong>
              <span>1 pending</span>
            </header>
            <h3>{pending[0].action}</h3>
            <p>{pending[0].reason}</p>
            <small>Risk: {pending[0].risk} · one-time authorization</small>
            <div>
              <button type="button" className="approve" onClick={() => onApprove(pending[0])}>
                ✓ Approve
              </button>
              <button type="button" className="decline" onClick={() => onReject(pending[0])}>
                × Deny
              </button>
            </div>
          </section>
        )}
        <details open>
          <summary>
            Tool activity <span>{activity.length}</span>
          </summary>
          <div className="detail-list-v2">
            {activity
              .slice(-10)
              .reverse()
              .map((item) => (
                <article key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <span className={item.status}>{item.status}</span>
                  </div>
                  <p>{item.detail}</p>
                </article>
              ))}
          </div>
        </details>
        <details open>
          <summary>
            Saved artifacts <span>{artifacts.length}</span>
          </summary>
          <div className="detail-list-v2">
            {artifacts.slice(0, 8).map((artifact) => (
              <article key={artifact.id}>
                <div>
                  <strong>{artifact.filename}</strong>
                  <span>{formatBytes(artifact.size)}</span>
                </div>
                <p>
                  {artifact.kind} · sha256 {artifact.sha256.slice(0, 12)}…
                </p>
              </article>
            ))}
            {artifacts.length === 0 && <Empty text="No saved evidence." />}
          </div>
        </details>
        <details open>
          <summary>
            Findings <span>{findings.length}</span>
          </summary>
          {findings.length > 0 && (
            <div className="finding-bars-v3">
              {(['critical', 'high', 'medium', 'low'] as const).map((severity) => (
                <div key={severity}>
                  <span>{severity}</span>
                  <i>
                    <b
                      style={{
                        width: `${Math.min(100, ((severityCounts[severity] ?? 0) / findings.length) * 100)}%`,
                      }}
                    />
                  </i>
                  <strong>{severityCounts[severity] ?? 0}</strong>
                </div>
              ))}
            </div>
          )}
          <div className="detail-list-v2 findings">
            {findings.slice(0, 8).map((finding) => (
              <article key={finding.id}>
                <div>
                  <strong>{finding.title}</strong>
                  <span className={finding.severity}>{finding.severity}</span>
                </div>
                <p>
                  {finding.status} · {finding.url}
                </p>
              </article>
            ))}
            {findings.length === 0 && <Empty text="No scanner signals." />}
          </div>
        </details>
        <details open>
          <summary>
            Coverage <span>{coveragePercent}%</span>
          </summary>
          <div className="coverage-progress-v3">
            <i>
              <b style={{ width: `${coveragePercent}%` }} />
            </i>
            <span>
              {coverageDone} of {coverageTotal} checks exercised
            </span>
          </div>
          <div className="coverage-v2">
            {['untested', 'tried', 'passed', 'failed', 'skipped'].map((key) => (
              <span key={key}>
                <strong>{coverage.summary[key] ?? 0}</strong>
                {key}
              </span>
            ))}
          </div>
          <div className="scanner-list-v2">
            {Object.entries(status?.scanners ?? {}).map(([name, scanner]) => (
              <span className={scanner.available && scanner.enabled ? 'ready' : ''} key={name}>
                <i />
                {name}
              </span>
            ))}
          </div>
        </details>
        <section className="audit-card-v3">
          <div>
            <span className="eyebrow">AUDIT</span>
            <strong>All actions recorded</strong>
          </div>
          <span>{events.length} events</span>
        </section>
      </aside>
    </div>
  );
}

function Recommendation({
  insight,
  onLoadSkill,
}: {
  insight: ReconInsight;
  onLoadSkill: (name: string, target?: string) => void;
}): React.ReactElement {
  return (
    <article className={`recommendation-v2 ${insight.priority}`}>
      <div>
        <span>{insight.priority}</span>
        <strong>{insight.title}</strong>
      </div>
      <p>{insight.rationale}</p>
      {insight.skill && (
        <button
          type="button"
          onClick={() => insight.skill && onLoadSkill(insight.skill, insight.target)}
        >
          Load /{insight.skill}
        </button>
      )}
    </article>
  );
}

function Empty({ text }: { text: string }): React.ReactElement {
  return <div className="empty-v2">{text}</div>;
}

function currentOperation(
  session: Session | undefined,
  run: ReconRun | undefined,
  proposals: ActionProposal[],
): { label: string; detail: string; kind: string } {
  const action = proposals.find((proposal) => proposal.status === 'running');
  const step = run?.steps.find((item) => item.status === 'running');
  const pending = proposals.find((proposal) => proposal.status === 'pending');
  if (action)
    return {
      label: action.action,
      detail: 'Approved scanner is running inside its isolated container.',
      kind: 'scanner',
    };
  if (step) return { label: toolForStep(step.key), detail: step.label, kind: 'recon' };
  if (session?.state === 'running')
    return {
      label: 'AI is analyzing',
      detail: `${session.provider} / ${session.model}`,
      kind: 'ai',
    };
  if (pending)
    return {
      label: `${pending.action} needs permission`,
      detail: 'Review the exact action before it can continue.',
      kind: 'approval',
    };
  return {
    label: 'Ready for the next run',
    detail: 'Nothing is executing on the target.',
    kind: 'idle',
  };
}

function defaultSteps(): ReconRun['steps'] {
  return ['scope', 'passive', 'dns', 'http', 'analysis'].map(
    (key, index) =>
      ({
        id: key,
        key,
        label: key === 'passive' ? 'Passive discovery' : key,
        status: 'pending',
        metrics: {},
        ordinal: index,
      }) as ReconRun['steps'][number],
  );
}

function filterOutput(events: RuntimeEvent[], filter: OutputFilter): RuntimeEvent[] {
  return events.filter((event) => {
    if (filter === 'tools')
      return (
        event.type.startsWith('agent.tool') ||
        event.type.startsWith('recon.') ||
        event.type.startsWith('action.') ||
        event.type === 'artifact.saved'
      );
    if (filter === 'ai')
      return (
        event.type.startsWith('agent.assistant') ||
        event.type === 'agent.decision' ||
        event.type === 'provider.cloud-preview'
      );
    return true;
  });
}

function buildToolActivity(
  run: ReconRun | undefined,
  proposals: ActionProposal[],
  events: RuntimeEvent[],
): ToolActivity[] {
  const steps = (run?.steps ?? []).map((step) => ({
    id: `step-${step.id}`,
    name: toolForStep(step.key),
    detail: step.detail ?? step.label,
    status: step.status,
  }));
  const actions = [...proposals]
    .reverse()
    .slice(-8)
    .map((proposal) => ({
      id: `action-${proposal.id}`,
      name: proposal.action,
      detail: proposal.reason,
      status: proposal.status,
    }));
  const results = new Map(
    events
      .filter((event) => event.type === 'agent.tool-result' && typeof event.payload.id === 'string')
      .map((event) => [String(event.payload.id), event]),
  );
  const calls = events
    .filter((event) => event.type === 'agent.tool-call' && typeof event.payload.id === 'string')
    .slice(-8)
    .map((event) => {
      const result = results.get(String(event.payload.id));
      return {
        id: `agent-${String(event.payload.id)}`,
        name: String(event.payload.name ?? 'typed tool'),
        detail: result
          ? `${Number(result.payload.durationMs) || 0} ms · result returned to AI`
          : 'AI requested this typed action',
        status: result ? (result.payload.err ? 'failed' : 'completed') : 'running',
      };
    });
  return [...steps, ...actions, ...calls].slice(-18);
}

function toolForStep(step: string): string {
  return (
    { scope: 'scope', passive: 'subfinder', dns: 'dnsx', http: 'httpx', analysis: 'analysis' }[
      step
    ] ?? step
  );
}

function latestAiText(events: RuntimeEvent[]): string {
  const lastTurn = events.map((event) => event.type).lastIndexOf('turn.started');
  const current = lastTurn >= 0 ? events.slice(lastTurn) : events;
  const complete = [...current]
    .reverse()
    .find(
      (event) => event.type === 'agent.assistant-text' && typeof event.payload.text === 'string',
    );
  if (complete) return String(complete.payload.text).slice(0, 12_000);
  return current
    .filter(
      (event) => event.type === 'agent.assistant-delta' && typeof event.payload.text === 'string',
    )
    .map((event) => String(event.payload.text))
    .join('')
    .slice(-12_000);
}

function eventTone(event: RuntimeEvent): string {
  if (event.type.includes('failed') || event.type.includes('error')) return 'error';
  if (event.type.startsWith('agent.assistant') || event.type === 'agent.decision') return 'ai';
  if (
    event.type.includes('tool') ||
    event.type.startsWith('recon.') ||
    event.type.startsWith('action.')
  )
    return 'tool';
  if (event.type === 'artifact.saved') return 'saved';
  return 'system';
}

function operatorEventText(event: RuntimeEvent): string {
  const payload = event.payload;
  const value =
    typeof payload.text === 'string'
      ? payload.text
      : typeof payload.result === 'string'
        ? payload.result
        : typeof payload.error === 'string'
          ? payload.error
          : event.type === 'turn.started' && typeof payload.message === 'string'
            ? payload.message
            : JSON.stringify(payload, null, 2);
  return String(value).slice(0, 20_000);
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}
