import { describe, expect, it } from 'vitest';
import { type ReconToolDefinition, ReconToolRegistry } from './toolRegistry.js';

describe('trusted recon tool registry', () => {
  it('contains only server-owned shell-free definitions', () => {
    const registry = new ReconToolRegistry();
    expect(registry.list().map((definition) => definition.name)).toEqual(
      expect.arrayContaining(['subfinder', 'crtsh', 'dnsx', 'httpx', 'katana']),
    );
    expect(registry.list().every((definition) => definition.shell === false)).toBe(true);
  });

  it('rejects duplicate and shell-enabled custom definitions', () => {
    const registry = new ReconToolRegistry([]);
    const trusted: ReconToolDefinition = {
      name: 'trusted-lines',
      executable: '/opt/workbench/trusted-lines',
      actionName: 'trusted_lines',
      argumentBuilder: () => ['--format', 'lines'],
      outputFormat: 'lines',
      parser: () => ({ values: [], malformed: 0 }),
      artifactDestination: 'trusted-lines',
      timeoutSeconds: 30,
      maximumOutputBytes: 1024,
      risk: 'low',
      requiresApproval: false,
      automaticExecutionAllowed: true,
      scopePolicy: 'passive-root-only',
      scopeValidator: () => true,
      shell: false,
    };
    registry.registerTrusted(trusted);
    expect(() => registry.registerTrusted(trusted)).toThrow('already registered');
    expect(() =>
      registry.registerTrusted({
        ...trusted,
        name: 'unsafe-shell',
        shell: true,
      } as unknown as ReconToolDefinition),
    ).toThrow('shell: false');
  });
});
