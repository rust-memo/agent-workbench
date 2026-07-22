import { describe, expect, it } from 'vitest';
import { listWebSkills, loadWebSkillRegistry } from './skills.js';

describe('Web skill catalog', () => {
  it('loads inherited and curated skills into the restricted Web runtime', () => {
    const registry = loadWebSkillRegistry();
    expect(registry.has('recon')).toBe(true);
    expect(registry.has('api-authorization')).toBe(true);
    expect(registry.has('business-logic')).toBe(true);
  });

  it('exposes provenance without leaking local skill paths or bodies', () => {
    const entries = listWebSkills();
    const apiAuthorization = entries.find((entry) => entry.name === 'api-authorization');
    expect(apiAuthorization).toMatchObject({
      category: 'authorization',
      risk: 'low',
      license: 'CC-BY-SA-4.0',
      sourceCommit: 'e85ddfa5a936d4656840ac250c039c7057e66b0d',
    });
    expect(JSON.stringify(entries)).not.toContain('/home/');
    expect(JSON.stringify(entries)).not.toContain('# API Authorization');
  });
});
