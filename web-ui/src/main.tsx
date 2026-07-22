import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type ActionProposal,
  type Artifact,
  type CoverageResponse,
  type Engagement,
  type Finding,
  type RuntimeEvent,
  type Session,
  type SlashCommand,
  type WorkbenchStatus,
  api,
  pairFromFragment,
  restoreSession,
} from './api';
import './styles.css';

function App(): React.ReactElement {
  const [auth, setAuth] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState('');
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [proposals, setProposals] = useState<ActionProposal[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [coverage, setCoverage] = useState<CoverageResponse>({ summary: {}, rows: [] });
  const [status, setStatus] = useState<WorkbenchStatus | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [providerDraft, setProviderDraft] = useState<Session['provider']>('qwen');
  const [modelDraft, setModelDraft] = useState('default');
  const [checkingProviders, setCheckingProviders] = useState(false);
  const [message, setMessage] = useState('');
  const [cancellingSession, setCancellingSession] = useState('');
  const [error, setError] = useState('');
  const [clearedThrough, setClearedThrough] = useState<Record<string, number>>({});
  const lastSeq = useRef(0);

  const refreshSessionData = useCallback(async (sessionId: string) => {
    const [files, actions, nextFindings, nextCoverage] = await Promise.all([
      api<Artifact[]>(`/sessions/${sessionId}/artifacts`),
      api<ActionProposal[]>(`/sessions/${sessionId}/actions`),
      api<Finding[]>(`/sessions/${sessionId}/findings`),
      api<CoverageResponse>(`/sessions/${sessionId}/coverage`),
    ]);
    setArtifacts(files);
    setProposals(actions);
    setFindings(nextFindings);
    setCoverage(nextCoverage);
  }, []);

  const refresh = useCallback(async () => {
    const [nextEngagements, nextSessions, nextStatus, nextCommands] = await Promise.all([
      api<Engagement[]>('/engagements'),
      api<Session[]>('/sessions'),
      api<WorkbenchStatus>('/status'),
      api<SlashCommand[]>('/commands'),
    ]);
    setEngagements(nextEngagements);
    setSessions(nextSessions);
    setStatus(nextStatus);
    setCommands(nextCommands);
    setSelected((current) => current || nextSessions[0]?.id || '');
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const paired = await pairFromFragment();
        const restored = paired || (await restoreSession());
        setAuth(restored ? 'ready' : 'missing');
        if (restored) await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setAuth('missing');
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (auth !== 'ready') return;
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let stopped = false;
    const connect = (): void => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(
        `${protocol}://${location.host}/api/v1/events/ws?after=${lastSeq.current}`,
      );
      socket.onmessage = (messageEvent) => {
        const event = JSON.parse(String(messageEvent.data)) as RuntimeEvent;
        lastSeq.current = Math.max(lastSeq.current, event.seq);
        setEvents((current) =>
          current.some((item) => item.eventId === event.eventId)
            ? current
            : [...current.slice(-999), event],
        );
        if (
          (event.type === 'artifact.saved' ||
            event.type.startsWith('action.') ||
            event.type.startsWith('finding.')) &&
          (!selected || event.sessionId === selected)
        ) {
          void refreshSessionData(event.sessionId);
        }
        if (
          event.type === 'turn.finished' ||
          event.type === 'action.completed' ||
          event.type === 'action.failed' ||
          event.type === 'action.cancelled'
        ) {
          setCancellingSession((current) => (current === event.sessionId ? '' : current));
          void refresh();
        }
      };
      socket.onclose = () => {
        if (!stopped) timer = window.setTimeout(connect, 1200);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [auth, refresh, refreshSessionData, selected]);

  useEffect(() => {
    if (!selected || auth !== 'ready') {
      setArtifacts([]);
      setProposals([]);
      setFindings([]);
      setCoverage({ summary: {}, rows: [] });
      return;
    }
    void Promise.all([
      api<RuntimeEvent[]>(`/events?after=0&sessionId=${encodeURIComponent(selected)}`),
      refreshSessionData(selected),
    ])
      .then(([history]) => {
        setEvents(history);
        lastSeq.current = Math.max(lastSeq.current, ...history.map((event) => event.seq), 0);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [selected, auth, refreshSessionData]);

  const activeSession = sessions.find((session) => session.id === selected);
  const activeEngagement = engagements.find(
    (engagement) => engagement.id === activeSession?.engagementId,
  );
  const visibleEvents = useMemo(
    () =>
      events.filter(
        (event) => event.sessionId === selected && event.seq > (clearedThrough[selected] ?? 0),
      ),
    [events, selected, clearedThrough],
  );
  const commandSuggestions = useMemo(() => {
    const trimmed = message.trimStart().toLowerCase();
    if (!trimmed.startsWith('/') || /\s/.test(trimmed)) return [];
    return commands.filter((command) => command.name.startsWith(trimmed)).slice(0, 8);
  }, [commands, message]);
  const activeCapability = status?.providers.find(
    (provider) => provider.provider === (activeSession?.provider ?? providerDraft),
  );
  const draftCapability = status?.providers.find((provider) => provider.provider === providerDraft);

  useEffect(() => {
    if (!activeSession) return;
    setProviderDraft(activeSession.provider);
    const capability = status?.providers.find(
      (provider) => provider.provider === activeSession.provider,
    );
    setModelDraft(
      activeSession.model === 'default'
        ? (capability?.models[0] ?? 'default')
        : activeSession.model,
    );
  }, [activeSession, status]);

  const checkProviders = async (): Promise<void> => {
    setCheckingProviders(true);
    try {
      setStatus(await api<WorkbenchStatus>('/status'));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCheckingProviders(false);
    }
  };

  const switchProvider = async (): Promise<void> => {
    if (!activeSession) return;
    try {
      await api(`/sessions/${activeSession.id}/provider`, {
        method: 'PATCH',
        body: JSON.stringify({
          provider: providerDraft,
          model: modelDraft || 'default',
        }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const submitTurn = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!selected || !message.trim()) return;
    const submitted = message.trim();
    if (submitted.startsWith('/')) {
      try {
        if (/^\/clear(?:\s|$)/i.test(submitted)) {
          setClearedThrough((current) => ({ ...current, [selected]: lastSeq.current }));
        }
        await api(`/sessions/${selected}/commands`, {
          method: 'POST',
          body: JSON.stringify({ command: submitted }),
        });
        setMessage('');
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    try {
      await api(`/sessions/${selected}/turns`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      setMessage('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const cancelTurn = async (): Promise<void> => {
    if (!selected || cancellingSession === selected) return;
    setCancellingSession(selected);
    setError('');
    try {
      const result = await api<{ cancelled: boolean }>(`/sessions/${selected}/cancel`, {
        method: 'POST',
      });
      if (!result.cancelled) {
        setCancellingSession('');
        await refresh();
        setError('This turn is no longer running.');
      }
    } catch (cause) {
      setCancellingSession('');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const approveAction = async (proposal: ActionProposal): Promise<void> => {
    if (!selected || proposal.status !== 'pending') return;
    const detail = JSON.stringify(proposal.arguments, null, 2);
    if (
      !window.confirm(
        `Approve one ${proposal.risk}-risk ${proposal.action} action?\n\nReason: ${proposal.reason}\n\nExact arguments:\n${detail}`,
      )
    )
      return;
    try {
      await api(`/sessions/${selected}/actions/${proposal.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvalHash: proposal.approvalHash }),
      });
      await Promise.all([refresh(), refreshSessionData(selected)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const updateFinding = async (finding: Finding, status: Finding['status']): Promise<void> => {
    if (!selected) return;
    let validationArtifactId: string | undefined;
    let validationNote: string | undefined;
    if (status === 'confirmed') {
      validationArtifactId = window
        .prompt('Artifact UUID containing manual request/response proof')
        ?.trim();
      if (!validationArtifactId) return;
      validationNote = window.prompt('Validation note (what was reproduced and observed)')?.trim();
      if (!validationNote || validationNote.length < 10) {
        setError('A validation note of at least 10 characters is required.');
        return;
      }
    }
    try {
      await api(`/sessions/${selected}/findings/${finding.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, validationArtifactId, validationNote }),
      });
      await refreshSessionData(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (auth === 'loading')
    return (
      <Centered title="Starting secure workbench…" detail="Restoring the local browser session." />
    );
  if (auth === 'missing')
    return (
      <Centered
        title="Pairing required"
        detail="Open the single-use URL printed by pentesterflow-web in your terminal."
        error={error}
      />
    );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">AW</span>
          <div>
            <strong>Agent Workbench</strong>
            <small>Local AI Security Workbench · v0.3.2</small>
          </div>
        </div>
        <div className="provider-switcher">
          <label>
            <span>Provider</span>
            <select
              value={providerDraft}
              onChange={(event) => {
                const provider = event.target.value as Session['provider'];
                setProviderDraft(provider);
                const capability = status?.providers.find((item) => item.provider === provider);
                setModelDraft(capability?.models[0] ?? 'default');
              }}
              disabled={!activeSession || activeSession.state === 'running'}
            >
              {status?.providers.map((provider) => (
                <option key={provider.provider} value={provider.provider}>
                  {provider.ready ? '✓' : '×'} {provider.label} · {provider.models.length} models
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Model</span>
            <select
              className="model-select"
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              disabled={!activeSession || activeSession.state === 'running'}
            >
              {modelDraft && !draftCapability?.models.includes(modelDraft) && (
                <option value={modelDraft}>{modelDraft}</option>
              )}
              {draftCapability?.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void switchProvider()}
            disabled={!activeSession || activeSession.state === 'running' || !modelDraft.trim()}
          >
            Apply
          </button>
          <button
            type="button"
            className="check-button"
            onClick={() => void checkProviders()}
            disabled={checkingProviders}
          >
            {checkingProviders ? 'Checking…' : 'Check models'}
          </button>
          <small className={draftCapability?.ready ? 'provider-ready' : 'provider-unavailable'}>
            {draftCapability?.ready
              ? `CLI ready · ${draftCapability.models.length} models discovered`
              : (draftCapability?.error ?? 'Unavailable')}
          </small>
        </div>
        <div className="top-status">
          <StatusPill label="Loopback" tone="good" />
          <StatusPill
            label={activeCapability?.label ?? 'Provider'}
            tone={activeCapability?.ready ? 'good' : 'warn'}
          />
          <StatusPill label={activeEngagement?.mode ?? 'NO MODE'} tone="neutral" />
        </div>
      </header>

      <aside className="sidebar">
        <div className="section-title">
          <span>Sessions</span>
          <button
            type="button"
            onClick={() =>
              void createWorkspace(
                refresh,
                setSelected,
                setError,
                providerDraft,
                modelDraft || 'default',
              )
            }
          >
            ＋
          </button>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <button
              type="button"
              key={session.id}
              className={`session-card ${selected === session.id ? 'active' : ''}`}
              onClick={() => setSelected(session.id)}
            >
              <span className={`state-dot ${session.state}`} />
              <span>
                <strong>{session.title}</strong>
                <small>
                  {session.provider} / {session.model} · {session.state}
                </small>
              </span>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="empty">Create your first scoped engagement.</div>
          )}
        </div>
        {activeEngagement && (
          <div className="scope-card">
            <small>SCOPE v{1}</small>
            <strong>{activeEngagement.name}</strong>
            {activeEngagement.scope.allowedHosts.map((host) => (
              <code key={host}>{host}</code>
            ))}
            <p>Discovery may be recorded outside scope. Active actions stay restricted.</p>
          </div>
        )}
      </aside>

      <main className="terminal-panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">LIVE SESSION</span>
            <h1>{activeSession?.title ?? 'No session selected'}</h1>
          </div>
          {activeSession?.state === 'running' && (
            <button
              type="button"
              className="danger"
              disabled={cancellingSession === selected}
              onClick={() => void cancelTurn()}
            >
              {cancellingSession === selected ? 'Cancelling…' : 'Cancel operation'}
            </button>
          )}
        </div>
        <ProgressDock events={visibleEvents} state={activeSession?.state ?? 'idle'} />
        <div className="terminal" role="log" aria-live="polite">
          {visibleEvents.length === 0 && (
            <div className="terminal-empty">
              <span>&gt;_</span>
              <p>
                Events, model output, tool calls, saves, and cancellation status appear here in real
                time.
              </p>
            </div>
          )}
          {visibleEvents.map((event) => (
            <EventLine key={event.eventId} event={event} />
          ))}
        </div>
        <div className="composer-wrap">
          {commandSuggestions.length > 0 && (
            <div className="command-menu">
              {commandSuggestions.map((command) => (
                <button
                  key={command.name}
                  type="button"
                  onClick={() => setMessage(`${command.name}${command.args ? ' ' : ''}`)}
                >
                  <code>
                    {command.name}
                    {command.args ? ` ${command.args}` : ''}
                  </code>
                  <span>{command.description}</span>
                </button>
              ))}
            </div>
          )}
          <form className="composer" onSubmit={(event) => void submitTurn(event)}>
            <span className="prompt">›</span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={!selected || activeSession?.state === 'running'}
              placeholder={
                activeEngagement?.mode === 'PLAN'
                  ? 'Ask anything or type / for commands…'
                  : 'Describe authorized recon or type / for commands…'
              }
              onKeyDown={(event) => {
                if (event.key === 'Tab' && commandSuggestions[0]) {
                  event.preventDefault();
                  setMessage(
                    `${commandSuggestions[0].name}${commandSuggestions[0].args ? ' ' : ''}`,
                  );
                } else if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              type="submit"
              disabled={!selected || !message.trim() || activeSession?.state === 'running'}
            >
              Run
            </button>
          </form>
        </div>
      </main>

      <aside className="inspector">
        <div className="section-title">
          <span>Approvals</span>
          <span className="count">
            {proposals.filter((item) => item.status === 'pending').length}
          </span>
        </div>
        <div className="approval-list">
          {proposals.slice(0, 6).map((proposal) => (
            <article className={`approval-card ${proposal.risk}`} key={proposal.id}>
              <div>
                <strong>{proposal.action}</strong>
                <span>
                  {proposal.risk} · {proposal.status}
                </span>
              </div>
              <p>{proposal.reason}</p>
              <code>{proposal.approvalHash.slice(0, 14)}…</code>
              {proposal.status === 'pending' && (
                <button type="button" onClick={() => void approveAction(proposal)}>
                  Review & approve once
                </button>
              )}
              {proposal.error && <small>{proposal.error}</small>}
            </article>
          ))}
          {proposals.length === 0 && (
            <div className="empty compact">Katana and Nuclei proposals appear here.</div>
          )}
        </div>
        <div className="section-title inspector-gap">
          <span>Findings</span>
          <span className="count">{findings.length}</span>
        </div>
        <div className="finding-list">
          {findings.slice(0, 8).map((finding) => (
            <article className="finding-card" key={finding.id}>
              <div>
                <span className={`severity ${finding.severity}`}>{finding.severity}</span>
                <strong>{finding.title}</strong>
              </div>
              <code>{finding.scannerReference}</code>
              <small>{finding.url}</small>
              <select
                aria-label={`Status for ${finding.title}`}
                value={finding.status}
                onChange={(event) =>
                  void updateFinding(finding, event.target.value as Finding['status'])
                }
              >
                <option value="needs_validation">Needs validation</option>
                <option value="confirmed">Confirmed manually</option>
                <option value="false_positive">False positive</option>
                <option value="informational">Informational</option>
              </select>
            </article>
          ))}
          {findings.length === 0 && (
            <div className="empty compact">Scanner hits stay unconfirmed until validation.</div>
          )}
        </div>
        <div className="section-title inspector-gap">
          <span>Coverage</span>
          <span className="count">{coverage.summary.total ?? 0}</span>
        </div>
        <div className="coverage-summary">
          {['untested', 'tried', 'passed', 'failed', 'skipped'].map((key) => (
            <span key={key}>
              <strong>{coverage.summary[key] ?? 0}</strong>
              {key}
            </span>
          ))}
        </div>
        <div className="section-title">
          <span>Artifacts</span>
          <span className="count">{artifacts.length}</span>
        </div>
        <div className="artifact-list">
          {artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
          {artifacts.length === 0 && (
            <div className="empty">Saved evidence will appear here with SHA-256 metadata.</div>
          )}
        </div>
        <div className="security-note">
          <span>SECURITY BOUNDARY</span>
          <p>
            Docker scanners use fixed images and arguments, no host mounts or credentials, and
            best-effort network scope enforcement.
          </p>
        </div>
      </aside>
      {error && (
        <button type="button" className="toast" onClick={() => setError('')}>
          {error}
          <span>×</span>
        </button>
      )}
    </div>
  );
}

function EventLine({ event }: { event: RuntimeEvent }): React.ReactElement {
  const payload = event.payload;
  const text =
    event.type === 'provider.cloud-preview'
      ? `Redacted payload dispatched · ${String(payload.provider)} / ${String(payload.model)} · ${formatBytes(Number(payload.bytes) || 0)} · ${Number(payload.redactionCount) || 0} redactions · sha256 ${String(payload.sha256).slice(0, 16)}…`
      : typeof payload.text === 'string'
        ? payload.text
        : typeof payload.result === 'string'
          ? payload.result
          : typeof payload.error === 'string'
            ? payload.error
            : event.type === 'turn.started' && typeof payload.message === 'string'
              ? payload.message
              : JSON.stringify(payload);
  const kind =
    event.type.includes('error') || payload.level === 'error'
      ? 'error'
      : event.type.includes('tool')
        ? 'tool'
        : event.type.includes('artifact')
          ? 'save'
          : event.type.includes('assistant')
            ? 'assistant'
            : 'system';
  return (
    <div className={`event-line ${kind}`}>
      <div className="event-meta">
        <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
        <span>{event.type}</span>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

function ProgressDock({
  events,
  state,
}: {
  events: RuntimeEvent[];
  state: Session['state'];
}): React.ReactElement {
  const latest = events.at(-1);
  const cloud = [...events].reverse().find((event) => event.type === 'provider.cloud-preview');
  const progress = operationProgress(latest, state);
  return (
    <section className={`progress-dock ${progress.tone}`} aria-label="Current operation progress">
      <div className="progress-summary">
        <div>
          <span className="eyebrow">OPERATION</span>
          <strong>{progress.label}</strong>
        </div>
        <span>{progress.percent}%</span>
      </div>
      <div className="progress-track" aria-hidden="true">
        <i style={{ width: `${progress.percent}%` }} />
      </div>
      <div className="progress-stages">
        {['Queued', 'Redacted', 'Running', 'Saving', 'Done'].map((stage, index) => (
          <span key={stage} className={progress.percent >= index * 25 ? 'active' : ''}>
            {stage}
          </span>
        ))}
      </div>
      {cloud && (
        <details className="cloud-preview">
          <summary>
            Cloud preview · {String(cloud.payload.provider)} / {String(cloud.payload.model)} ·{' '}
            {formatBytes(Number(cloud.payload.bytes) || 0)} ·{' '}
            {Number(cloud.payload.redactionCount) || 0} redactions
          </summary>
          <div className="preview-meta">
            SHA-256 <code>{String(cloud.payload.sha256)}</code>
          </div>
          <pre>{String(cloud.payload.preview ?? '')}</pre>
        </details>
      )}
    </section>
  );
}

function operationProgress(
  latest: RuntimeEvent | undefined,
  state: Session['state'],
): { label: string; percent: number; tone: string } {
  if (!latest) return { label: 'Ready for a turn', percent: 0, tone: 'idle' };
  if (state === 'cancelled' || latest.type.includes('cancelled'))
    return { label: 'Operation cancelled', percent: 100, tone: 'cancelled' };
  if (state === 'error' || latest.type.includes('error') || latest.type === 'action.failed')
    return { label: 'Operation stopped with an error', percent: 100, tone: 'error' };
  if (latest.type === 'turn.finished' || latest.type === 'action.completed')
    return { label: 'Operation complete', percent: 100, tone: 'done' };
  if (latest.type.includes('cancel-requested'))
    return { label: 'Stopping the current operation…', percent: 75, tone: 'running' };
  if (latest.type === 'provider.cloud-preview')
    return { label: 'Redacted payload dispatched to the model', percent: 35, tone: 'running' };
  if (latest.type === 'artifact.saved')
    return { label: 'Saving verified artifact metadata', percent: 85, tone: 'running' };
  if (latest.type.includes('tool-result') || latest.type.includes('assistant'))
    return { label: 'Processing model response', percent: 65, tone: 'running' };
  if (latest.type === 'action.started')
    return { label: 'Isolated scanner is running', percent: 40, tone: 'running' };
  if (latest.type === 'turn.started')
    return { label: 'Preparing redacted model context', percent: 15, tone: 'running' };
  return state === 'running'
    ? { label: 'Operation in progress', percent: 50, tone: 'running' }
    : { label: 'Ready for a turn', percent: 0, tone: 'idle' };
}

function ArtifactCard({ artifact }: { artifact: Artifact }): React.ReactElement {
  const [preview, setPreview] = useState('');
  return (
    <article className="artifact-card">
      <div>
        <span className="file-icon">◇</span>
        <div>
          <strong>{artifact.filename}</strong>
          <small>
            {artifact.kind} · {formatBytes(artifact.size)}
          </small>
        </div>
      </div>
      <code>{artifact.sha256.slice(0, 16)}…</code>
      <div className="artifact-actions">
        <button
          type="button"
          onClick={() =>
            void api<{ body: string }>(`/artifacts/${artifact.id}/preview`).then((value) =>
              setPreview(value.body),
            )
          }
        >
          Redacted preview
        </button>
        <a href={`/api/v1/artifacts/${artifact.id}/raw`}>Raw download</a>
      </div>
      {preview && <pre className="preview">{preview}</pre>}
    </article>
  );
}

function Centered({
  title,
  detail,
  error,
}: { title: string; detail: string; error?: string }): React.ReactElement {
  return (
    <div className="centered">
      <span className="brand-mark large">AW</span>
      <h1>{title}</h1>
      <p>{detail}</p>
      {error && <code>{error}</code>}
    </div>
  );
}
function StatusPill({ label, tone }: { label: string; tone: string }): React.ReactElement {
  return (
    <span className={`pill ${tone}`}>
      <i />
      {label}
    </span>
  );
}
function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}

async function createWorkspace(
  refresh: () => Promise<void>,
  select: (id: string) => void,
  fail: (message: string) => void,
  provider: Session['provider'],
  model: string,
): Promise<void> {
  const host = window.prompt('Authorized host (example.com or *.example.com)');
  if (!host) return;
  const name = window.prompt('Engagement name', host) || host;
  const requestedMode = window.prompt('Mode: PLAN or RECON', 'PLAN')?.trim().toUpperCase();
  const mode = requestedMode === 'RECON' ? 'RECON' : 'PLAN';
  try {
    const engagement = await api<Engagement>('/engagements', {
      method: 'POST',
      body: JSON.stringify({
        name,
        mode,
        scope: {
          allowedHosts: [host],
          allowThirdPartyPassiveSources: false,
          allowDirectLowImpactRecon: true,
          limits: {
            requestsPerSecond: 5,
            concurrency: 5,
            maxUrlsPerHost: 500,
            maxRedirects: 0,
            maxRuntimeSeconds: 300,
            maxOutputBytes: 10485760,
          },
        },
      }),
    });
    const session = await api<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        engagementId: engagement.id,
        title: `${name} / ${mode === 'PLAN' ? 'Plan' : 'Recon'}`,
        provider,
        model,
      }),
    });
    await refresh();
    select(session.id);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('missing root element');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
