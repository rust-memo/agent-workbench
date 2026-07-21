export type WebMode = 'PLAN' | 'RECON';
export type WebProviderId = 'ollama' | 'qwen' | 'opencode' | 'openclaude';

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
