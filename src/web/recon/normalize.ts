import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { hostInScope } from '../scope.js';
import type { ReconAssetType, ScopeDefinition } from '../types.js';

export interface NormalizedReconValue {
  value: string;
  normalizedValue: string;
  host: string;
  type: ReconAssetType;
  inScope: boolean;
  activeTestingAllowed: boolean;
}

/**
 * Normalize untrusted scanner output without making it executable. Wildcard
 * certificate entries become their concrete suffix and malformed values are
 * rejected before they reach the asset database.
 */
export function normalizeReconValue(
  rawValue: string,
  scope: ScopeDefinition,
): NormalizedReconValue {
  const value = rawValue.trim();
  if (!value || value.length > 4096 || /[\0\r\n]/.test(value))
    throw new Error('empty or oversized recon value');

  if (/^https?:\/\//i.test(value)) return normalizeUrl(value, scope);

  const wildcardStripped = value.replace(/^(?:\*\.)+/, '');
  if (isIP(wildcardStripped)) {
    const inScope = hostInScope(wildcardStripped, scope);
    return {
      value,
      normalizedValue: wildcardStripped.toLowerCase(),
      host: wildcardStripped.toLowerCase(),
      type: 'ip',
      inScope,
      activeTestingAllowed: inScope && scope.allowDirectLowImpactRecon,
    };
  }

  const host = normalizeDomain(wildcardStripped);
  const inScope = hostInScope(host, scope);
  return {
    value,
    normalizedValue: host,
    host,
    type: classifyDomainType(host, scope),
    inScope,
    activeTestingAllowed: inScope && scope.allowDirectLowImpactRecon,
  };
}

function normalizeUrl(value: string, scope: ScopeDefinition): NormalizedReconValue {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('unsupported recon URL');
  parsed.hostname = isIP(parsed.hostname) ? parsed.hostname : normalizeDomain(parsed.hostname);
  parsed.hash = '';
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  )
    parsed.port = '';
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const inScope = hostInScope(host, scope);
  return {
    value,
    normalizedValue: parsed.toString(),
    host,
    type: 'url',
    inScope,
    activeTestingAllowed: inScope && scope.allowDirectLowImpactRecon,
  };
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/, '');
  if (!trimmed || trimmed.length > 253 || trimmed.includes('/') || trimmed.includes(':'))
    throw new Error('invalid domain');
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253) throw new Error('invalid IDN domain');
  const labels = ascii.split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  )
    throw new Error('malformed domain');
  return ascii.toLowerCase();
}

function classifyDomainType(host: string, scope: ScopeDefinition): 'domain' | 'subdomain' {
  const roots = scope.allowedHosts.map((entry) =>
    entry.replace(/^\*\./, '').toLowerCase().replace(/\.$/, ''),
  );
  return roots.includes(host) ? 'domain' : 'subdomain';
}
