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

export interface ActionProposalRecord {
  id: string;
  engagementId: string;
  sessionId: string;
  turnId?: string;
  action: 'katana' | 'nuclei';
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
