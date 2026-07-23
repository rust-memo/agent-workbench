export interface Engagement {
  id: string;
  name: string;
  mode: 'PLAN' | 'RECON';
  scope: {
    version: number;
    allowedHosts: string[];
    allowThirdPartyPassiveSources: boolean;
    allowDirectLowImpactRecon: boolean;
    limits: {
      requestsPerSecond: number;
      concurrency: number;
      maxUrlsPerHost: number;
      maxRedirects: number;
      maxRuntimeSeconds: number;
      maxOutputBytes: number;
    };
  };
}
export interface Session {
  id: string;
  engagementId: string;
  title: string;
  provider: 'ollama' | 'qwen' | 'codex' | 'claude' | 'opencode' | 'openclaude';
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
  scanners: Record<
    string,
    { available: boolean; detail: string; profile: 'safe' | 'raw'; enabled: boolean }
  >;
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
export interface WorkbenchSkill {
  name: string;
  description: string;
  explicitOnly: boolean;
  category: string;
  risk: 'low' | 'medium' | 'high';
  compatibility: Array<'cli' | 'web'>;
  source: string;
  sourceCommit?: string;
  license: string;
  provenance: string;
}
export interface Artifact {
  id: string;
  engagementId?: string;
  sessionId: string;
  turnId?: string;
  kind: string;
  filename: string;
  mediaType?: string;
  size: number;
  sha256: string;
  status: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
export interface ActionProposal {
  id: string;
  sessionId: string;
  action: 'katana' | 'nuclei' | 'ffuf' | 'nmap_connect' | 'nmap_raw' | 'validate_http';
  arguments: Record<string, unknown>;
  reason: string;
  risk: 'medium' | 'high';
  approvalHash: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';
  expiresAt: string;
  resultArtifactId?: string;
  error?: string;
}
export interface LegacySession {
  id: string;
  fileName: string;
  updatedAt: string;
  preview: string;
  imported?: { sessionId: string; importedAt: string };
}
export interface Finding {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  status: 'needs_validation' | 'confirmed' | 'false_positive' | 'informational';
  url: string;
  scanner: 'nuclei';
  scannerReference: string;
}
export interface CoverageRow {
  id: string;
  asset: string;
  endpoint: string;
  parameter: string;
  vulnerabilityClass: string;
  status: 'untested' | 'tried' | 'passed' | 'failed' | 'waf-blocked' | 'skipped';
  source: string;
  attempts: number;
}
export interface CoverageResponse {
  summary: Record<string, number>;
  rows: CoverageRow[];
}
export interface ReconStep {
  id: string;
  key: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled';
  artifactId?: string;
  detail?: string;
  metrics: Record<string, unknown>;
}
export interface ReconInsight {
  id: string;
  type: 'asset' | 'signal' | 'recommendation' | 'manual-test';
  priority: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  rationale: string;
  target?: string;
  skill?: string;
  status: 'new' | 'accepted' | 'dismissed' | 'completed';
}
export interface ReconRun {
  id: string;
  sessionId: string;
  profile: 'quick' | 'standard' | 'advanced';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentStep?: string;
  progress: number;
  summary: Record<string, unknown>;
  createdAt: string;
  steps: ReconStep[];
  insights: ReconInsight[];
}

export interface ReconAssetSource {
  id: string;
  tool: string;
  runId: string;
  toolRunId: string;
  artifactId?: string;
  rawValue: string;
  discoveredAt: string;
}

export interface ReconAsset {
  id: string;
  runId: string;
  value: string;
  normalizedValue: string;
  type: 'domain' | 'subdomain' | 'url' | 'ip';
  sources: ReconAssetSource[];
  inScope: boolean;
  activeTestingAllowed: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  dns?: { resolved: boolean; addresses: string[]; cname?: string };
  http?: {
    probed: boolean;
    live: boolean;
    finalUrl?: string;
    statusCode?: number;
    title?: string;
    technologies?: string[];
    contentType?: string;
    webServer?: string;
  };
}

export interface ReconToolRun {
  id: string;
  reconRunId: string;
  tool: string;
  actionName: string;
  status: 'queued' | 'running' | 'saving' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  rawResults: number;
  validResults: number;
  uniqueResults: number;
  artifactIds: string[];
  error?: string;
  partialStdout?: string;
  partialStderr?: string;
  metadata: Record<string, unknown>;
}

export interface ReconHttpResult {
  id: string;
  assetId: string;
  input: string;
  url: string;
  host: string;
  port?: number;
  scheme?: string;
  statusCode?: number;
  contentLength?: number;
  title?: string;
  technologies: string[];
  webServer?: string;
  contentType?: string;
  finalUrl?: string;
  ip?: string;
  cname?: string;
  responseTime?: string;
}

export interface ReconArtifactLink {
  id: string;
  runId: string;
  toolRunId?: string;
  artifactId: string;
  role: string;
}

export interface AssetInterest {
  id: string;
  assetId: string;
  score: number;
  reasons: string[];
  markedBy: 'user' | 'ai';
  reviewStatus: 'new' | 'reviewing' | 'dismissed' | 'promoted';
}

export interface ReconResultsResponse {
  run: ReconRun | null;
  toolRuns: ReconToolRun[];
  assets: ReconAsset[];
  httpResults: ReconHttpResult[];
  artifactLinks: ReconArtifactLink[];
  interests: Record<string, AssetInterest[]>;
}

export interface AIReview {
  id: string;
  runId?: string;
  status: 'pending_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
  provider: Session['provider'];
  model: string;
  objective: string;
  inputArtifactIds: string[];
  inputAssetIds: string[];
  inputHashes: string[];
  redactedPreview: string;
  payloadBytes: number;
  responseArtifactId?: string;
  error?: string;
  artifactNames?: string[];
  assetCount?: number;
  createdAt: string;
}

export interface ArtifactContent {
  artifact: Artifact;
  view: 'redacted' | 'raw';
  startLine: number;
  totalLines: number;
  hasMore: boolean;
  lines: Array<{ number: number; text: string }>;
  matches: number[];
  matchesTruncated: boolean;
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
