export type WebMode = 'PLAN' | 'RECON';
export type WebProviderId = 'ollama' | 'qwen' | 'codex' | 'claude' | 'opencode' | 'openclaude';

export interface ProviderCapabilities {
  provider: WebProviderId;
  label: string;
  version: string;
  ready: boolean;
  error?: string;
  streaming: boolean;
  structuredOutput: boolean;
  planMode: boolean;
  sandbox: boolean;
  toolDisable: boolean;
  modelDiscovery: boolean;
  externalContextWarning: boolean;
  models: string[];
  checkedAt: string;
}

export interface ScopeDefinition {
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
}

export type ScannerLimits = ScopeDefinition['limits'];

export type ActionRisk = 'medium' | 'high';
export type ActionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';
export type WebActionName =
  | 'katana'
  | 'nuclei'
  | 'ffuf'
  | 'nmap_connect'
  | 'nmap_raw'
  | 'validate_http';

export interface ActionProposalRecord {
  id: string;
  engagementId: string;
  sessionId: string;
  turnId?: string;
  action: WebActionName;
  arguments: Record<string, unknown>;
  reason: string;
  risk: ActionRisk;
  scopeVersion: number;
  approvalHash: string;
  status: ActionStatus;
  expiresAt: string;
  approvedBy?: string;
  approvedAt?: string;
  consumedAt?: string;
  resultArtifactId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'needs_validation' | 'confirmed' | 'false_positive' | 'informational';

export interface WebFindingRecord {
  id: string;
  engagementId: string;
  sessionId: string;
  actionProposalId?: string;
  evidenceArtifactId: string;
  title: string;
  severity: FindingSeverity;
  status: FindingStatus;
  confidence: 'scanner';
  url: string;
  scanner: 'nuclei';
  scannerReference: string;
  description?: string;
  remediation?: string;
  validationArtifactId?: string;
  validationNote?: string;
  createdAt: string;
  updatedAt: string;
}

export type CoverageStatus = 'untested' | 'tried' | 'passed' | 'failed' | 'waf-blocked' | 'skipped';

export interface WebCoverageRecord {
  id: string;
  engagementId: string;
  sessionId: string;
  asset: string;
  endpoint: string;
  parameter: string;
  vulnerabilityClass: string;
  status: CoverageStatus;
  source: string;
  notes?: string;
  attempts: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RuntimeEvent<T = unknown> {
  seq: number;
  eventId: string;
  engagementId: string;
  sessionId: string;
  turnId?: string;
  type: string;
  payload: T;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  engagementId: string;
  sessionId: string;
  turnId?: string;
  kind: string;
  filename: string;
  relativePath: string;
  mediaType: string;
  size: number;
  sha256: string;
  status: 'ready' | 'missing' | 'corrupt' | 'orphan-recovered';
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type ReconProfile = 'quick' | 'standard' | 'advanced';
export type ReconRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ReconStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'cancelled';
export type ReconPriority = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ReconStepRecord {
  id: string;
  runId: string;
  ordinal: number;
  key: string;
  label: string;
  status: ReconStepStatus;
  artifactId?: string;
  detail?: string;
  metrics: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
}

export interface ReconInsightRecord {
  id: string;
  runId: string;
  sessionId: string;
  type: 'asset' | 'signal' | 'recommendation' | 'manual-test';
  priority: ReconPriority;
  title: string;
  rationale: string;
  target?: string;
  skill?: string;
  status: 'new' | 'accepted' | 'dismissed' | 'completed';
  sourceStep?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReconRunRecord {
  id: string;
  engagementId: string;
  sessionId: string;
  profile: ReconProfile;
  status: ReconRunStatus;
  currentStep?: string;
  progress: number;
  summary: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  steps: ReconStepRecord[];
  insights: ReconInsightRecord[];
}

export type ReconToolRunStatus =
  | 'queued'
  | 'running'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type ReconAssetType = 'domain' | 'subdomain' | 'url' | 'ip';

export interface ReconAssetSource {
  id: string;
  assetId: string;
  tool: string;
  runId: string;
  toolRunId: string;
  artifactId?: string;
  rawValue: string;
  discoveredAt: string;
}

export interface ReconAsset {
  id: string;
  engagementId: string;
  sessionId: string;
  runId: string;
  value: string;
  normalizedValue: string;
  type: ReconAssetType;
  sources: ReconAssetSource[];
  inScope: boolean;
  activeTestingAllowed: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  dns?: {
    resolved: boolean;
    addresses: string[];
    cname?: string;
  };
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

export interface ReconToolRunRecord {
  id: string;
  reconRunId: string;
  engagementId: string;
  sessionId: string;
  tool: string;
  actionName: string;
  status: ReconToolRunStatus;
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
  createdAt: string;
  updatedAt: string;
}

export interface ReconHttpResult {
  id: string;
  assetId: string;
  runId: string;
  toolRunId: string;
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
  raw: Record<string, unknown>;
  createdAt: string;
}

export interface ReconArtifactLink {
  id: string;
  runId: string;
  toolRunId?: string;
  artifactId: string;
  role: 'raw' | 'parsed' | 'metadata' | 'combined' | 'httpx' | 'failed-inputs' | 'ai-review';
  createdAt: string;
}

export interface AssetInterest {
  id: string;
  assetId: string;
  score: number;
  reasons: string[];
  markedBy: 'user' | 'ai';
  reviewStatus: 'new' | 'reviewing' | 'dismissed' | 'promoted';
  createdAt: string;
  updatedAt: string;
}

export interface AIReviewRecord {
  id: string;
  engagementId: string;
  sessionId: string;
  runId?: string;
  status: 'pending_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
  provider: WebProviderId;
  model: string;
  objective: string;
  inputArtifactIds: string[];
  inputAssetIds: string[];
  inputHashes: string[];
  redactedPreview: string;
  payloadBytes: number;
  responseArtifactId?: string;
  error?: string;
  createdAt: string;
  approvedAt?: string;
  completedAt?: string;
}
