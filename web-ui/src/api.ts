export interface Engagement {
  id: string;
  name: string;
  mode: 'PLAN' | 'RECON';
  scope: {
    allowedHosts: string[];
    allowThirdPartyPassiveSources: boolean;
    allowDirectLowImpactRecon: boolean;
  };
}
export interface Session {
  id: string;
  engagementId: string;
  title: string;
  provider: 'ollama' | 'qwen' | 'opencode' | 'openclaude';
  model: string;
  state: 'idle' | 'running' | 'cancelled' | 'error';
}
export interface ProviderCapability {
  provider: Session['provider'];
  label: string;
  version: string;
  ready: boolean;
  error?: string;
  sandbox: boolean;
  toolDisable: boolean;
  modelDiscovery: boolean;
  externalContextWarning: boolean;
  models: string[];
  checkedAt: string;
}
export interface WorkbenchStatus {
  version: string;
  providers: ProviderCapability[];
  scanners: Record<string, { available: boolean; detail: string }>;
  scopeEnforcement: string;
}
export interface RuntimeEvent {
  seq: number;
  eventId: string;
  sessionId: string;
  turnId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}
export interface Artifact {
  id: string;
  sessionId: string;
  kind: string;
  filename: string;
  size: number;
  sha256: string;
  status: string;
  createdAt: string;
}

let csrfToken = '';

export function setCsrf(value: string): void {
  csrfToken = value;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(method)) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof body.error === 'string' ? body.error : `Request failed (${response.status})`,
    );
  return body as T;
}

export async function pairFromFragment(): Promise<boolean> {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('pair');
  if (!token) return false;
  try {
    const response = await fetch('/api/v1/auth/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const body = (await response.json()) as { csrfToken?: string };
    if (!response.ok || !body.csrfToken) throw new Error('Pairing failed');
    setCsrf(body.csrfToken);
    return true;
  } finally {
    history.replaceState(null, '', '/');
  }
}

export async function restoreSession(): Promise<boolean> {
  try {
    const response = await api<{ csrfToken: string }>('/auth/session');
    setCsrf(response.csrfToken);
    return true;
  } catch {
    return false;
  }
}
