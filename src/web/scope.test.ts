import { describe, expect, it } from 'vitest';
import { classifyDiscoveredValue, createScope, hostInScope } from './scope.js';

describe('web scope policy', () => {
  const scope = createScope({
    allowedHosts: ['example.com', '*.lab.example'],
    allowThirdPartyPassiveSources: false,
    allowDirectLowImpactRecon: true,
  });

  it('matches exact and wildcard hosts without broad suffix confusion', () => {
    expect(hostInScope('example.com', scope)).toBe(true);
    expect(hostInScope('api.lab.example', scope)).toBe(true);
    expect(hostInScope('lab.example', scope)).toBe(false);
    expect(hostInScope('example.com.attacker.test', scope)).toBe(false);
  });

  it('records out-of-scope discoveries without authorizing them', () => {
    expect(classifyDiscoveredValue('https://auth.third-party.test/login', scope)).toEqual({
      value: 'https://auth.third-party.test/login',
      host: 'auth.third-party.test',
      inScope: false,
      activeTestingAllowed: false,
    });
  });
});
