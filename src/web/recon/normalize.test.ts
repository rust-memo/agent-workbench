import { describe, expect, it } from 'vitest';
import { createScope } from '../scope.js';
import { normalizeReconValue } from './normalize.js';

const scope = createScope({
  allowedHosts: ['example.com', '*.example.com'],
  allowThirdPartyPassiveSources: true,
  allowDirectLowImpactRecon: true,
});

describe('normalizeReconValue', () => {
  it('normalizes IDNs, wildcard certificate names, trailing dots, and equivalent URLs', () => {
    expect(normalizeReconValue('*.API.Example.com.', scope)).toMatchObject({
      normalizedValue: 'api.example.com',
      type: 'subdomain',
      inScope: true,
    });
    expect(normalizeReconValue('https://API.Example.com:443/a#fragment', scope)).toMatchObject({
      normalizedValue: 'https://api.example.com/a',
      type: 'url',
      inScope: true,
    });
    expect(normalizeReconValue('münich.example.com', scope).normalizedValue).toBe(
      'xn--mnich-kva.example.com',
    );
  });

  it('rejects malformed scanner output', () => {
    for (const value of ['not-a-domain', 'bad..example.com', 'https://user:pass@example.com/']) {
      expect(() => normalizeReconValue(value, scope)).toThrow();
    }
  });
});
