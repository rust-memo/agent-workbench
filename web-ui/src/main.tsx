import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, pairFromFragment, restoreSession, type Artifact, type Engagement, type RuntimeEvent, type Session, type WorkbenchStatus } from './api';
import './styles.css';

function App(): React.ReactElement {
  const [auth, setAuth] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState('');
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [status, setStatus] = useState<WorkbenchStatus | null>(null);
  const [providerDraft, setProviderDraft] = useState<Session['provider']>('qwen');
  const [modelDraft, setModelDraft] = useState('default');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const lastSeq = useRef(0);

  const refresh = useCallback(async () => {
    const [nextEngagements, nextSessions, nextStatus] = await Promise.all([
      api<Engagement[]>('/engagements'), api<Session[]>('/sessions'), api<WorkbenchStatus>('/status'),
    ]);
    setEngagements(nextEngagements);
    setSessions(nextSessions);
    setStatus(nextStatus);
    setSelected((current) => current || nextSessions[0]?.id || '');
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const paired = await pairFromFragment();
        const restored = paired || await restoreSession();
        setAuth(restored ? 'ready' : 'missing');
        if (restored) await refresh();
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setAuth('missing'); }
    })();
  }, [refresh]);

  useEffect(() => {
    if (auth !== 'ready') return;
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let stopped = false;
    const connect = (): void => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/api/v1/events/ws?after=${lastSeq.current}`);
      socket.onmessage = (messageEvent) => {
        const event = JSON.parse(String(messageEvent.data)) as RuntimeEvent;
        lastSeq.current = Math.max(lastSeq.current, event.seq);
        setEvents((current) => current.some((item) => item.eventId === event.eventId) ? current : [...current.slice(-999), event]);
        if (event.type === 'artifact.saved' && (!selected || event.sessionId === selected)) {
          void api<Artifact[]>(`/sessions/${event.sessionId}/artifacts`).then(setArtifacts);
        }
        if (event.type === 'turn.finished') void refresh();
      };
      socket.onclose = () => { if (!stopped) timer = window.setTimeout(connect, 1200); };
    };
    connect();
    return () => { stopped = true; if (timer) clearTimeout(timer); socket?.close(); };
  }, [auth, refresh, selected]);

  useEffect(() => {
    if (!selected || auth !== 'ready') { setArtifacts([]); return; }
    void Promise.all([
      api<RuntimeEvent[]>(`/events?after=0&sessionId=${encodeURIComponent(selected)}`),
      api<Artifact[]>(`/sessions/${selected}/artifacts`),
    ]).then(([history, files]) => {
      setEvents(history);
      setArtifacts(files);
      lastSeq.current = Math.max(lastSeq.current, ...history.map((event) => event.seq), 0);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [selected, auth]);

  const activeSession = sessions.find((session) => session.id === selected);
  const activeEngagement = engagements.find((engagement) => engagement.id === activeSession?.engagementId);
  const visibleEvents = useMemo(() => events.filter((event) => event.sessionId === selected), [events, selected]);
  const activeCapability = status?.providers.find((provider) => provider.provider === (activeSession?.provider ?? providerDraft));
  const draftCapability = status?.providers.find((provider) => provider.provider === providerDraft);

  useEffect(() => {
    if (!activeSession) return;
    setProviderDraft(activeSession.provider);
    setModelDraft(activeSession.model);
  }, [activeSession?.id, activeSession?.provider, activeSession?.model]);

  const switchProvider = async (): Promise<void> => {
    if (!activeSession) return;
    const external = providerDraft !== 'ollama';
    if (external && !window.confirm(`${draftCapability?.label ?? providerDraft} may send the redacted session context to its configured remote model. Continue?`)) return;
    try {
      await api(`/sessions/${activeSession.id}/provider`, { method: 'PATCH', body: JSON.stringify({
        provider: providerDraft, model: modelDraft || 'default', externalContextApproved: external,
      }) });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const submitTurn = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!selected || !message.trim()) return;
    const external = activeSession?.provider !== 'ollama';
    if (external && !window.confirm(`${activeCapability?.label ?? activeSession?.provider} may send this turn's session context to its configured remote model. Approve this turn?`)) return;
    try {
      await api(`/sessions/${selected}/turns`, { method: 'POST', body: JSON.stringify({ message, externalContextApproved: external }) });
      setMessage('');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  if (auth === 'loading') return <Centered title="Starting secure workbench…" detail="Restoring the local browser session." />;
  if (auth === 'missing') return <Centered title="Pairing required" detail="Open the single-use URL printed by pentesterflow-web in your terminal." error={error} />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">PF</span><div><strong>PentesterFlow</strong><small>Local Security Workbench · v0.2.0</small></div></div>
        <div className="provider-switcher">
          <label><span>Provider</span><select value={providerDraft} onChange={(event) => { const provider = event.target.value as Session['provider']; setProviderDraft(provider); const capability = status?.providers.find((item) => item.provider === provider); setModelDraft(capability?.models[0] ?? 'default'); }} disabled={!activeSession || activeSession.state === 'running'}>{status?.providers.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.label}{provider.ready ? '' : ' · unavailable'}</option>)}</select></label>
          <label><span>Model</span><input list="provider-models" value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} disabled={!activeSession || activeSession.state === 'running'} /><datalist id="provider-models">{draftCapability?.models.map((model) => <option key={model} value={model} />)}</datalist></label>
          <button onClick={() => void switchProvider()} disabled={!activeSession || activeSession.state === 'running' || !modelDraft.trim()}>Apply</button>
        </div>
        <div className="top-status"><StatusPill label="Loopback" tone="good" /><StatusPill label={activeCapability?.label ?? 'Provider'} tone={activeCapability?.ready ? 'good' : 'warn'} /><StatusPill label={activeEngagement?.mode ?? 'NO MODE'} tone="neutral" /></div>
      </header>

      <aside className="sidebar">
        <div className="section-title"><span>Sessions</span><button onClick={() => void createWorkspace(refresh, setSelected, setError)}>＋</button></div>
        <div className="session-list">
          {sessions.map((session) => <button key={session.id} className={`session-card ${selected === session.id ? 'active' : ''}`} onClick={() => setSelected(session.id)}>
            <span className={`state-dot ${session.state}`} /><span><strong>{session.title}</strong><small>{session.provider} / {session.model} · {session.state}</small></span>
          </button>)}
          {sessions.length === 0 && <div className="empty">Create your first scoped engagement.</div>}
        </div>
        {activeEngagement && <div className="scope-card"><small>SCOPE v{1}</small><strong>{activeEngagement.name}</strong>{activeEngagement.scope.allowedHosts.map((host) => <code key={host}>{host}</code>)}<p>Discovery may be recorded outside scope. Active actions stay restricted.</p></div>}
      </aside>

      <main className="terminal-panel">
        <div className="panel-head"><div><span className="eyebrow">LIVE SESSION</span><h1>{activeSession?.title ?? 'No session selected'}</h1></div>{activeSession?.state === 'running' && <button className="danger" onClick={() => void api(`/sessions/${selected}/cancel`, { method: 'POST' })}>Cancel turn</button>}</div>
        <div className="terminal" role="log" aria-live="polite">
          {visibleEvents.length === 0 && <div className="terminal-empty"><span>&gt;_</span><p>Events, model output, tool calls, saves, and cancellation status appear here in real time.</p></div>}
          {visibleEvents.map((event) => <EventLine key={event.eventId} event={event} />)}
        </div>
        <form className="composer" onSubmit={(event) => void submitTurn(event)}>
          <span className="prompt">›</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} disabled={!selected || activeSession?.state === 'running'} placeholder={activeEngagement?.mode === 'PLAN' ? 'Ask the agent to produce a plan…' : 'Describe the authorized recon objective…'} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <button type="submit" disabled={!selected || !message.trim() || activeSession?.state === 'running'}>Run</button>
        </form>
      </main>

      <aside className="inspector">
        <div className="section-title"><span>Artifacts</span><span className="count">{artifacts.length}</span></div>
        <div className="artifact-list">{artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}{artifacts.length === 0 && <div className="empty">Saved evidence will appear here with SHA-256 metadata.</div>}</div>
        <div className="security-note"><span>SECURITY BOUNDARY</span><p>Web tools cannot run arbitrary shell commands. v0.2.0 uses validated inputs and best-effort network scope enforcement.</p></div>
      </aside>
      {error && <button className="toast" onClick={() => setError('')}>{error}<span>×</span></button>}
    </div>
  );
}

function EventLine({ event }: { event: RuntimeEvent }): React.ReactElement {
  const payload = event.payload;
  const text = typeof payload.text === 'string' ? payload.text : typeof payload.result === 'string' ? payload.result :
    typeof payload.error === 'string' ? payload.error : event.type === 'turn.started' && typeof payload.message === 'string' ? payload.message : JSON.stringify(payload);
  const kind = event.type.includes('error') ? 'error' : event.type.includes('tool') ? 'tool' : event.type.includes('artifact') ? 'save' : event.type.includes('assistant') ? 'assistant' : 'system';
  return <div className={`event-line ${kind}`}><div className="event-meta"><time>{new Date(event.createdAt).toLocaleTimeString()}</time><span>{event.type}</span></div><pre>{text}</pre></div>;
}

function ArtifactCard({ artifact }: { artifact: Artifact }): React.ReactElement {
  const [preview, setPreview] = useState('');
  return <article className="artifact-card"><div><span className="file-icon">◇</span><div><strong>{artifact.filename}</strong><small>{artifact.kind} · {formatBytes(artifact.size)}</small></div></div><code>{artifact.sha256.slice(0, 16)}…</code><div className="artifact-actions"><button onClick={() => void api<{ body: string }>(`/artifacts/${artifact.id}/preview`).then((value) => setPreview(value.body))}>Redacted preview</button><a href={`/api/v1/artifacts/${artifact.id}/raw`}>Raw download</a></div>{preview && <pre className="preview">{preview}</pre>}</article>;
}

function Centered({ title, detail, error }: { title: string; detail: string; error?: string }): React.ReactElement {
  return <div className="centered"><span className="brand-mark large">PF</span><h1>{title}</h1><p>{detail}</p>{error && <code>{error}</code>}</div>;
}
function StatusPill({ label, tone }: { label: string; tone: string }): React.ReactElement { return <span className={`pill ${tone}`}><i />{label}</span>; }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`; }

async function createWorkspace(refresh: () => Promise<void>, select: (id: string) => void, fail: (message: string) => void): Promise<void> {
  const host = window.prompt('Authorized host (example.com or *.example.com)');
  if (!host) return;
  const name = window.prompt('Engagement name', host) || host;
  try {
    const engagement = await api<Engagement>('/engagements', { method: 'POST', body: JSON.stringify({ name, mode: 'RECON', scope: {
      allowedHosts: [host], allowThirdPartyPassiveSources: false, allowDirectLowImpactRecon: true,
      limits: { requestsPerSecond: 5, concurrency: 5, maxUrlsPerHost: 500, maxRedirects: 0, maxRuntimeSeconds: 300, maxOutputBytes: 10485760 },
    } }) });
    const session = await api<Session>('/sessions', { method: 'POST', body: JSON.stringify({ engagementId: engagement.id, title: `${name} / Recon`, provider: 'qwen', model: 'default' }) });
    await refresh(); select(session.id);
  } catch (cause) { fail(cause instanceof Error ? cause.message : String(cause)); }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
