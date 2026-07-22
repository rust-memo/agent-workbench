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
type StreamFilter = 'all' | 'tools' | 'ai';
type ActivityItem = { id: string; tool: string; detail: string; status: string };

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
  const [filter, setFilter] = useState<StreamFilter>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const streamRef = useRef<HTMLDivElement>(null);
  const running =
    session?.state === 'running' || run?.status === 'running' || run?.status === 'queued';
  const pending = proposals.filter((proposal) => proposal.status === 'pending');
  const visibleEvents = useMemo(() => filterEvents(events, filter), [events, filter]);
  const activity = useMemo(() => buildActivity(run, proposals, events), [run, proposals, events]);
  const recommendations = (run?.insights ?? []).filter(
    (insight) => insight.status === 'new' || insight.status === 'accepted',
  );
  const scanners = Object.entries(status?.scanners ?? {});
  const readyScanners = scanners.filter(
    ([, scanner]) => scanner.available && scanner.enabled,
  ).length;
  const provider = status?.providers.find((item) => item.provider === session?.provider);

  useEffect(() => {
    if (!autoScroll) return;
    const node = streamRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  });

  return (
    <section className="mission-center">
      <header className="mission-overview">
        <MissionStat
          icon="◎"
          label="Target"
          value={engagement?.scope.allowedHosts[0] ?? 'No target selected'}
          detail={`${engagement?.scope.allowedHosts.length ?? 0} scope rules`}
        />
        <MissionStat
          icon="⌾"
          label="Mode"
          value={engagement?.mode ?? 'Not configured'}
          detail={running ? 'Operation in progress' : 'Ready for controlled execution'}
          tone="green"
        />
        <MissionStat
          icon="✣"
          label="Provider / Model"
          value={provider?.label ?? session?.provider ?? 'No provider'}
          detail={session?.model ?? 'No model selected'}
          tone="blue"
        />
        <MissionStat
          icon="♢"
          label="Scanner Health"
          value={readyScanners > 0 ? 'Healthy' : 'Needs attention'}
          detail={`${readyScanners} of ${scanners.length} ready`}
          tone={readyScanners > 0 ? 'green' : 'amber'}
        />
      </header>

      <div className="mission-toolbar">
        <div className="mission-scope">
          <span>Authorized scope · v{engagement?.scope.version ?? 0}</span>
          <strong>{engagement?.scope.allowedHosts.join(' · ') ?? 'No scope selected'}</strong>
        </div>

        <nav className="mission-pages" aria-label="Operator view">
          <button
            type="button"
            className={page === 'run' ? 'active' : ''}
            onClick={() => onPageChange('run')}
          >
            Live session <small>{running ? 'live' : `${run?.progress ?? 0}%`}</small>
          </button>
          <button
            type="button"
            className={page === 'output' ? 'active' : ''}
            onClick={() => onPageChange('output')}
          >
            Evidence <small>{artifacts.length + findings.length}</small>
          </button>
        </nav>

        <div className="mission-actions">
          <details className="mission-policy">
            <summary>Policy</summary>
            <div>
              <button
                type="button"
                className={engagement?.scope.allowThirdPartyPassiveSources ? 'enabled' : ''}
                disabled={!engagement || running || policyBusy}
                onClick={onTogglePassive}
              >
                Passive sources
                <span>
                  {engagement?.scope.allowThirdPartyPassiveSources ? 'Allowed' : 'Approval needed'}
                </span>
              </button>
              <button
                type="button"
                className={
                  engagement?.scope.allowedHosts.some((host) => host.startsWith('*.'))
                    ? 'enabled'
                    : ''
                }
                disabled={!engagement || running || policyBusy}
                onClick={onToggleSubdomains}
              >
                Subdomains
                <span>
                  {engagement?.scope.allowedHosts.some((host) => host.startsWith('*.'))
                    ? 'In scope'
                    : 'Discovery only'}
                </span>
              </button>
            </div>
          </details>
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
            <button type="button" className="mission-stop" onClick={onCancel}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="mission-start"
              disabled={!session || engagement?.mode !== 'RECON'}
              onClick={onStart}
            >
              Start finder
            </button>
          )}
        </div>
      </div>

      <div className={`mission-body ${page}`}>
        <Transcript
          title={page === 'run' ? 'Session Transcript' : 'Output & Evidence Stream'}
          events={visibleEvents}
          filter={filter}
          onFilter={setFilter}
          autoScroll={autoScroll}
          onAutoScroll={setAutoScroll}
          streamRef={streamRef}
          run={run}
        />

        <MissionRail
          page={page}
          pending={pending}
          artifacts={artifacts}
          findings={findings}
          coverage={coverage}
          activity={activity}
          scanners={scanners}
          events={events}
          recommendations={recommendations}
          analyzing={analyzing}
          onAnalyze={onAnalyze}
          onApprove={onApprove}
          onReject={onReject}
          onLoadSkill={onLoadSkill}
        />
      </div>
    </section>
  );
}

function MissionStat({
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
  tone?: 'neutral' | 'green' | 'blue' | 'amber';
}): React.ReactElement {
  return (
    <article className={`mission-stat ${tone}`}>
      <i>{icon}</i>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function Transcript({
  title,
  events,
  filter,
  onFilter,
  autoScroll,
  onAutoScroll,
  streamRef,
  run,
}: {
  title: string;
  events: RuntimeEvent[];
  filter: StreamFilter;
  onFilter: (filter: StreamFilter) => void;
  autoScroll: boolean;
  onAutoScroll: (value: boolean) => void;
  streamRef: React.RefObject<HTMLDivElement | null>;
  run?: ReconRun;
}): React.ReactElement {
  return (
    <section className="transcript-card">
      <header>
        <div>
          <strong>{title}</strong>
          <span className="stream-state">
            <i /> Streaming
          </span>
        </div>
        <div className="transcript-controls">
          <div className="stream-filters">
            {(['all', 'tools', 'ai'] as const).map((item) => (
              <button
                type="button"
                className={filter === item ? 'active' : ''}
                onClick={() => onFilter(item)}
                key={item}
              >
                {item}
              </button>
            ))}
          </div>
          <label>
            Auto-scroll
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(event) => onAutoScroll(event.target.checked)}
            />
            <span />
          </label>
        </div>
      </header>

      {run && (
        <div className="transcript-progress">
          <div>
            <span>{run.currentStep ?? run.status}</span>
            <strong>{run.progress}%</strong>
          </div>
          <i>
            <b style={{ width: `${run.progress}%` }} />
          </i>
        </div>
      )}

      <div className="transcript-stream" ref={streamRef} role="log" aria-live="polite">
        {events.slice(-240).map((event) => (
          <article className={eventTone(event)} key={event.eventId}>
            <time>{formatTime(event.createdAt)}</time>
            <span>{eventLabel(event)}</span>
            <pre>{eventText(event)}</pre>
          </article>
        ))}
        {events.length === 0 && (
          <div className="transcript-empty">
            <span>&gt;_</span>
            <strong>Waiting for the first operation</strong>
            <p>Tool calls, AI analysis, approvals, and saved evidence will stream here.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function MissionRail({
  page,
  pending,
  artifacts,
  findings,
  coverage,
  activity,
  scanners,
  events,
  recommendations,
  analyzing,
  onAnalyze,
  onApprove,
  onReject,
  onLoadSkill,
}: {
  page: OperatorPage;
  pending: ActionProposal[];
  artifacts: Artifact[];
  findings: Finding[];
  coverage: CoverageResponse;
  activity: ActivityItem[];
  scanners: Array<
    [string, { available: boolean; detail: string; profile: 'safe' | 'raw'; enabled: boolean }]
  >;
  events: RuntimeEvent[];
  recommendations: ReconInsight[];
  analyzing: boolean;
  onAnalyze: () => void;
  onApprove: (proposal: ActionProposal) => void;
  onReject: (proposal: ActionProposal) => void;
  onLoadSkill: (name: string, target?: string) => void;
}): React.ReactElement {
  const totalCoverage = coverage.summary.total ?? coverage.rows.length;
  const completedCoverage = Math.max(0, totalCoverage - (coverage.summary.untested ?? 0));
  const coveragePercent = totalCoverage ? Math.round((completedCoverage / totalCoverage) * 100) : 0;
  const severity = findings.reduce<Record<string, number>>((result, finding) => {
    result[finding.severity] = (result[finding.severity] ?? 0) + 1;
    return result;
  }, {});

  return (
    <aside className="mission-rail">
      <ApprovalPanel proposal={pending[0]} onApprove={onApprove} onReject={onReject} />

      {page === 'output' && (
        <RailCard title="Tool activity" count={activity.length} className="tool-activity-card">
          <div className="rail-list">
            {activity
              .slice(-5)
              .reverse()
              .map((item) => (
                <article key={item.id}>
                  <span className={`rail-dot ${item.status}`} />
                  <div>
                    <strong>{item.tool}</strong>
                    <small>{item.detail}</small>
                  </div>
                  <em>{item.status}</em>
                </article>
              ))}
            {activity.length === 0 && <RailEmpty text="No tool activity yet." />}
          </div>
        </RailCard>
      )}

      <RailCard title="Artifacts" count={artifacts.length}>
        <div className="artifact-peek">
          {artifacts.slice(-3).map((artifact) => (
            <article key={artifact.id}>
              <span>▱</span>
              <strong>{artifact.filename}</strong>
              <time>{formatTime(artifact.createdAt)}</time>
            </article>
          ))}
          {artifacts.length === 0 && <RailEmpty text="No evidence saved yet." />}
        </div>
      </RailCard>

      <RailCard title="Findings" count={findings.length}>
        <div className="severity-bars">
          {(['critical', 'high', 'medium', 'low'] as const).map((level) => (
            <div key={level}>
              <span>{level}</span>
              <i>
                <b
                  style={{
                    width: `${findings.length ? ((severity[level] ?? 0) / findings.length) * 100 : 0}%`,
                  }}
                />
              </i>
              <strong>{severity[level] ?? 0}</strong>
            </div>
          ))}
        </div>
      </RailCard>

      <RailCard title="Coverage" count={`${coveragePercent}%`}>
        <div className="coverage-peek">
          <i>
            <b style={{ width: `${coveragePercent}%` }} />
          </i>
          <span>
            {completedCoverage} of {totalCoverage} checks exercised
          </span>
          <div>
            {scanners.map(([name, scanner]) => (
              <small className={scanner.available && scanner.enabled ? 'ready' : ''} key={name}>
                <i /> {name}
              </small>
            ))}
          </div>
        </div>
      </RailCard>

      <RailCard
        title="AI assessment"
        action={analyzing ? 'Analyzing…' : 'Analyze'}
        onAction={onAnalyze}
      >
        <div className="recommendation-peek">
          {recommendations.slice(0, 2).map((insight) => (
            <article key={insight.id}>
              <span>{insight.priority}</span>
              <div>
                <strong>{insight.title}</strong>
                <p>{insight.rationale}</p>
              </div>
              {insight.skill && (
                <button
                  type="button"
                  onClick={() => insight.skill && onLoadSkill(insight.skill, insight.target)}
                >
                  /{insight.skill}
                </button>
              )}
            </article>
          ))}
          {recommendations.length === 0 && (
            <RailEmpty text="Analyze evidence for ranked next steps." />
          )}
        </div>
      </RailCard>

      <section className="audit-strip">
        <span>Audit</span>
        <strong>All actions recorded</strong>
        <small>{events.length} events</small>
      </section>
    </aside>
  );
}

function ApprovalPanel({
  proposal,
  onApprove,
  onReject,
}: {
  proposal?: ActionProposal;
  onApprove: (proposal: ActionProposal) => void;
  onReject: (proposal: ActionProposal) => void;
}): React.ReactElement {
  return (
    <section className={`approval-panel ${proposal ? 'pending' : 'clear'}`}>
      <header>
        <strong>Approvals</strong>
        <span>{proposal ? '1 pending' : 'Clear'}</span>
      </header>
      {proposal ? (
        <>
          <h3>{proposal.action}</h3>
          <dl>
            <div>
              <dt>Risk</dt>
              <dd>{proposal.risk}</dd>
            </div>
            <div>
              <dt>Authorization</dt>
              <dd>Single use</dd>
            </div>
          </dl>
          <p>{proposal.reason}</p>
          <div className="approval-buttons">
            <button type="button" className="approve" onClick={() => onApprove(proposal)}>
              ✓ Approve
            </button>
            <button type="button" className="deny" onClick={() => onReject(proposal)}>
              × Deny
            </button>
          </div>
        </>
      ) : (
        <div className="approval-clear">
          <i>✓</i>
          <p>No action is waiting for authorization.</p>
        </div>
      )}
    </section>
  );
}

function RailCard({
  title,
  count,
  action,
  onAction,
  className = '',
  children,
}: {
  title: string;
  count?: number | string;
  action?: string;
  onAction?: () => void;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className={`rail-card ${className}`}>
      <header>
        <strong>{title}</strong>
        {action ? (
          <button type="button" onClick={onAction}>
            {action}
          </button>
        ) : (
          <span>{count}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function RailEmpty({ text }: { text: string }): React.ReactElement {
  return <p className="rail-empty">{text}</p>;
}

function filterEvents(events: RuntimeEvent[], filter: StreamFilter): RuntimeEvent[] {
  return events.filter((event) => {
    if (filter === 'tools')
      return (
        event.type.includes('tool') ||
        event.type.startsWith('recon.') ||
        event.type.startsWith('action.') ||
        event.type === 'artifact.saved'
      );
    if (filter === 'ai')
      return event.type.startsWith('agent.assistant') || event.type === 'agent.decision';
    return true;
  });
}

function buildActivity(
  run: ReconRun | undefined,
  proposals: ActionProposal[],
  events: RuntimeEvent[],
): ActivityItem[] {
  const steps = (run?.steps ?? []).map((step) => ({
    id: `step-${step.id}`,
    tool: stepTool(step.key),
    detail: step.detail ?? step.label,
    status: step.status,
  }));
  const actions = proposals.map((proposal) => ({
    id: `action-${proposal.id}`,
    tool: proposal.action,
    detail: proposal.reason,
    status: proposal.status,
  }));
  const toolResults = new Set(
    events
      .filter((event) => event.type === 'agent.tool-result')
      .map((event) => String(event.payload.id ?? '')),
  );
  const calls = events
    .filter((event) => event.type === 'agent.tool-call')
    .map((event) => ({
      id: `tool-${String(event.payload.id ?? event.eventId)}`,
      tool: String(event.payload.name ?? 'typed tool'),
      detail: toolResults.has(String(event.payload.id ?? ''))
        ? 'Result returned to the AI'
        : 'Requested by the AI',
      status: toolResults.has(String(event.payload.id ?? '')) ? 'completed' : 'running',
    }));
  return [...steps, ...actions, ...calls].slice(-24);
}

function stepTool(key: string): string {
  return (
    { scope: 'scope', passive: 'subfinder', dns: 'dnsx', http: 'httpx', analysis: 'analysis' }[
      key
    ] ?? key
  );
}

function eventTone(event: RuntimeEvent): string {
  if (event.type.includes('failed') || event.type.includes('error')) return 'error';
  if (event.type.includes('approval') || event.type.endsWith('.proposed')) return 'approval';
  if (event.type.startsWith('agent.assistant') || event.type === 'agent.decision') return 'ai';
  if (event.type === 'artifact.saved') return 'artifact';
  if (event.type.includes('tool') || event.type.startsWith('action.')) return 'scan';
  if (event.type.startsWith('recon.')) return 'recon';
  return 'system';
}

function eventLabel(event: RuntimeEvent): string {
  const tone = eventTone(event);
  if (tone === 'ai') return 'ai';
  if (tone === 'artifact') return 'artifact';
  if (tone === 'scan') return 'scan';
  if (tone === 'approval') return 'approval';
  if (tone === 'recon') return 'recon';
  return 'system';
}

function eventText(event: RuntimeEvent): string {
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
            : compactPayload(payload);
  return String(value).slice(0, 20_000);
}

function compactPayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return 'Event recorded';
  if (entries.length <= 3 && entries.every(([, value]) => typeof value !== 'object'))
    return entries.map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
  return JSON.stringify(payload, null, 2);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
