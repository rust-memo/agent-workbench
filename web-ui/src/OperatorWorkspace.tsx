import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActionProposal,
  Artifact,
  Engagement,
  Finding,
  ReconInsight,
  ReconRun,
  RuntimeEvent,
  Session,
  WorkbenchStatus,
} from './api';

type OutputFilter = 'all' | 'tools' | 'ai';

export function OperatorWorkspace({
  engagement,
  session,
  run,
  profile,
  events,
  artifacts,
  proposals,
  findings,
  status,
  analyzing,
  policyBusy,
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
  status: WorkbenchStatus | null;
  analyzing: boolean;
  policyBusy: boolean;
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
  const actionRunning = proposals.find((proposal) => proposal.status === 'running');
  const currentStep = run?.steps.find((step) => step.status === 'running');
  const operation = actionRunning
    ? { label: actionRunning.action, detail: 'Approved scanner is running', kind: 'scanner' }
    : currentStep
      ? { label: toolForStep(currentStep.key), detail: currentStep.label, kind: 'recon' }
      : session?.state === 'running'
        ? { label: 'AI reasoning', detail: `${session.provider} / ${session.model}`, kind: 'ai' }
        : pending[0]
          ? { label: pending[0].action, detail: 'Waiting for your approval', kind: 'approval' }
          : { label: 'Ready', detail: 'Start recon or ask AI to analyze evidence', kind: 'idle' };

  const outputEvents = useMemo(
    () =>
      events.filter((event) => {
        if (outputFilter === 'tools')
          return (
            event.type.startsWith('agent.tool') ||
            event.type.startsWith('recon.') ||
            event.type.startsWith('action.') ||
            event.type === 'artifact.saved'
          );
        if (outputFilter === 'ai')
          return (
            event.type.startsWith('agent.assistant') ||
            event.type === 'agent.decision' ||
            event.type === 'provider.cloud-preview'
          );
        return true;
      }),
    [events, outputFilter],
  );

  useEffect(() => {
    const node = outputRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  });

  const toolActivity = useMemo(
    () => buildToolActivity(run, proposals, events),
    [run, proposals, events],
  );
  const aiText = useMemo(() => latestAiText(events), [events]);
  const recommendations = (run?.insights ?? []).filter(
    (insight) => insight.status === 'new' || insight.status === 'accepted',
  );
  const completedTools = toolActivity.filter((item) => item.status === 'completed').length;
  const readyScanners = Object.values(status?.scanners ?? {}).filter(
    (scanner) => scanner.available && scanner.enabled,
  ).length;

  return (
    <section className="operator-workspace">
      <header className="operator-commandbar">
        <div className={`operation-beacon ${operation.kind}`}>
          <span className={running ? 'pulse' : ''} />
          <div>
            <small>NOW OPERATING</small>
            <strong>{operation.label}</strong>
            <p>{operation.detail}</p>
          </div>
        </div>
        <div className="operator-target">
          <small>AUTHORIZED SCOPE</small>
          <strong>{engagement?.scope.allowedHosts.join(', ') ?? 'No scope selected'}</strong>
          <span>Outside discoveries are visible but never authorized automatically.</span>
          <div className="operator-scope-policy">
            <button
              type="button"
              className={engagement?.scope.allowThirdPartyPassiveSources ? 'enabled' : ''}
              onClick={onTogglePassive}
              disabled={!engagement || running || policyBusy}
              title="Allow Subfinder to query third-party passive data sources"
            >
              Subfinder {engagement?.scope.allowThirdPartyPassiveSources ? 'ENABLED' : 'DISABLED'}
            </button>
            <button
              type="button"
              className={
                engagement?.scope.allowedHosts.some((host) => host.startsWith('*.'))
                  ? 'enabled'
                  : ''
              }
              onClick={onToggleSubdomains}
              disabled={!engagement || running || policyBusy}
              title="Allow low-impact recon on discovered subdomains"
            >
              Subdomains{' '}
              {engagement?.scope.allowedHosts.some((host) => host.startsWith('*.'))
                ? 'IN SCOPE'
                : 'DISCOVERY ONLY'}
            </button>
          </div>
        </div>
        <label className="operator-profile">
          <span>Pipeline</span>
          <select
            value={profile}
            disabled={!session || running}
            onChange={(event) => onProfile(event.target.value as ReconRun['profile'])}
          >
            <option value="quick">Quick finder</option>
            <option value="standard">Standard finder</option>
            <option value="advanced">Advanced finder</option>
          </select>
        </label>
        {running ? (
          <button type="button" className="operator-stop" onClick={onCancel}>
            Stop operation
          </button>
        ) : (
          <button
            type="button"
            className="operator-start"
            onClick={onStart}
            disabled={!session || engagement?.mode !== 'RECON'}
          >
            ▶ Start finder
          </button>
        )}
      </header>

      <div className="operator-metrics">
        <span>
          <strong>{run?.progress ?? 0}%</strong> pipeline
        </span>
        <span>
          <strong>{completedTools}</strong> tools completed
        </span>
        <span>
          <strong>{artifacts.length}</strong> evidence files
        </span>
        <span>
          <strong>{pending.length}</strong> permission gates
        </span>
        <span>
          <strong>{findings.length}</strong> scanner signals
        </span>
        <span>
          <strong>{readyScanners}</strong> scanners ready
        </span>
      </div>

      <div className="operator-grid">
        <section className="operator-card tool-monitor">
          <header>
            <div>
              <span className="eyebrow">EXECUTION QUEUE</span>
              <h2>Tools & steps</h2>
            </div>
            <span className="live-badge">LIVE</span>
          </header>
          <div className="tool-activity-list">
            {toolActivity.map((item, index) => (
              <article className={`tool-activity ${item.status}`} key={item.id}>
                <span className="tool-index">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.detail}</small>
                </div>
                {item.name === 'subfinder' && item.status === 'skipped' ? (
                  <button type="button" className="tool-fix" onClick={onStart}>
                    Enable & rerun
                  </button>
                ) : (
                  <span className="tool-status">{item.status.replace('_', ' ')}</span>
                )}
              </article>
            ))}
            {toolActivity.length === 0 && (
              <div className="operator-empty">
                Start a scoped Recon run to populate the execution queue.
              </div>
            )}
          </div>
          <footer className="scanner-health-strip">
            {Object.entries(status?.scanners ?? {}).map(([name, scanner]) => (
              <span
                key={name}
                className={scanner.available && scanner.enabled ? 'ready' : 'offline'}
              >
                <i /> {name}
              </span>
            ))}
          </footer>
        </section>

        <section className="operator-card output-monitor">
          <header>
            <div>
              <span className="eyebrow">STREAMING OUTPUT</span>
              <h2>Tool output & audit</h2>
            </div>
            <div className="output-filters">
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
          </header>
          <div className="operator-output" ref={outputRef} role="log" aria-live="polite">
            {outputEvents.slice(-120).map((event) => (
              <div className={`operator-event ${eventTone(event)}`} key={event.eventId}>
                <div>
                  <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                  <span>{event.type}</span>
                </div>
                <pre>{operatorEventText(event)}</pre>
              </div>
            ))}
            {outputEvents.length === 0 && (
              <div className="terminal-empty">
                <span>&gt;_</span>
                <p>
                  Live scanner state, tool calls, results, saved evidence, and AI output appear
                  here.
                </p>
              </div>
            )}
          </div>
        </section>

        <aside className="operator-card intelligence-monitor">
          <header>
            <div>
              <span className="eyebrow">AI TRIAGE</span>
              <h2>Analysis & next move</h2>
            </div>
            <span className={`ai-state ${session?.state ?? 'idle'}`}>
              {session?.provider ?? 'AI'}
            </span>
          </header>
          <div className="ai-analysis">
            <div className="ai-analysis-head">
              <strong>Latest analyst response</strong>
              <button
                type="button"
                onClick={onAnalyze}
                disabled={!session || running || analyzing || (!run && artifacts.length === 0)}
              >
                {analyzing ? 'Dispatching…' : 'Analyze evidence with AI'}
              </button>
            </div>
            <pre>
              {aiText ||
                'Run recon, then ask the selected AI to triage saved evidence and recommend the next bounded tests.'}
            </pre>
          </div>

          <div className="operator-subhead">
            <span>RECOMMENDATIONS</span>
            <strong>{recommendations.length}</strong>
          </div>
          <div className="operator-recommendations">
            {recommendations.slice(0, 5).map((insight) => (
              <Recommendation key={insight.id} insight={insight} onLoadSkill={onLoadSkill} />
            ))}
            {recommendations.length === 0 && (
              <div className="operator-empty">
                Recommendations appear after discovery and AI triage.
              </div>
            )}
          </div>

          <div className="operator-subhead permission-title">
            <span>PERMISSION GATE</span>
            <strong>{pending.length}</strong>
          </div>
          <div className="operator-permissions">
            {pending.slice(0, 4).map((proposal) => (
              <article key={proposal.id}>
                <div>
                  <strong>{proposal.action}</strong>
                  <span className={`risk ${proposal.risk}`}>{proposal.risk}</span>
                </div>
                <p>{proposal.reason}</p>
                <small>
                  Single use · expires {new Date(proposal.expiresAt).toLocaleTimeString()}
                </small>
                <div className="permission-actions">
                  <button type="button" className="approve" onClick={() => onApprove(proposal)}>
                    Approve & run
                  </button>
                  <button type="button" className="reject" onClick={() => onReject(proposal)}>
                    Decline
                  </button>
                </div>
              </article>
            ))}
            {pending.length === 0 && (
              <div className="operator-empty">No scanner is waiting for permission.</div>
            )}
          </div>
        </aside>
      </div>
    </section>
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
    <article className={`operator-recommendation ${insight.priority}`}>
      <div>
        <span>{insight.priority}</span>
        <strong>{insight.title}</strong>
      </div>
      <p>{insight.rationale}</p>
      {insight.target && <code>{insight.target}</code>}
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

function buildToolActivity(
  run: ReconRun | undefined,
  proposals: ActionProposal[],
  events: RuntimeEvent[],
): Array<{ id: string; name: string; detail: string; status: string }> {
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
    {
      scope: 'scope_targets',
      passive: 'subfinder',
      dns: 'dnsx',
      http: 'httpx',
      analysis: 'evidence analyzer',
    }[step] ?? step
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
