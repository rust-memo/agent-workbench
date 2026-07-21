import { domainToASCII } from 'node:url';
import { z } from 'zod';
import type { ScopeDefinition } from './types.js';

const hostPattern = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value) => value.toLowerCase().replace(/\.$/, ''))
  .refine((value) => {
    const bare = value.startsWith('*.') ? value.slice(2) : value;
    return Boolean(domainToASCII(bare)) && !bare.includes('/') && !bare.includes(':');
  }, 'invalid host pattern');

export const scopeSchema = z.object({
  allowedHosts: z.array(hostPattern).min(1).max(100),
  allowThirdPartyPassiveSources: z.boolean().default(false),
  allowDirectLowImpactRecon: z.boolean().default(false),
  limits: z
    .object({
      requestsPerSecond: z.number().int().min(1).max(50).default(5),
      concurrency: z.number().int().min(1).max(20).default(5),
      maxUrlsPerHost: z.number().int().min(1).max(10_000).default(500),
      maxRedirects: z.number().int().min(0).max(5).default(0),
      maxRuntimeSeconds: z.number().int().min(5).max(3600).default(300),
      maxOutputBytes: z
        .number()
        .int()
        .min(1024)
        .max(100 * 1024 * 1024)
        .default(10 * 1024 * 1024),
    })
    .default({}),
});

export function createScope(input: unknown, version = 1): ScopeDefinition {
  const parsed = scopeSchema.parse(input);
  return { version, ...parsed };
}

export function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.includes('/') || ascii.includes(':'))
    throw new Error(`invalid host: ${value}`);
  return ascii;
}

export function hostInScope(host: string, scope: ScopeDefinition): boolean {
  let normalized: string;
  try {
    normalized = normalizeHost(host);
  } catch {
    return false;
  }
  return scope.allowedHosts.some((pattern) => {
    const p = normalizeHost(pattern.startsWith('*.') ? pattern.slice(2) : pattern);
    if (pattern.startsWith('*.')) return normalized !== p && normalized.endsWith(`.${p}`);
    return normalized === p;
  });
}

export function classifyDiscoveredValue(
  value: string,
  scope: ScopeDefinition,
): { value: string; host: string; inScope: boolean; activeTestingAllowed: boolean } {
  let host = value;
  try {
    host = new URL(value).hostname;
  } catch {
    // Domain-only output is expected from subfinder.
  }
  const normalized = normalizeHost(host);
  const inScope = hostInScope(normalized, scope);
  return {
    value,
    host: normalized,
    inScope,
    activeTestingAllowed: inScope && scope.allowDirectLowImpactRecon,
  };
}
