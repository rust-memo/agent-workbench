import { describe, expect, it } from 'vitest';
import { actionApprovalHash, canonicalJson } from './canonical.js';

describe('canonical action approval hashes', () => {
  it('is stable across object key order', () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 } })).toBe(
      canonicalJson({ nested: { a: 1, b: 2 }, z: 1 }),
    );
  });

  it('changes when any approved argument or the scope changes', () => {
    const base = {
      action: 'katana',
      arguments: { inputArtifactId: 'f2f8936c-cb87-4e02-89d1-298625156ec7', depth: 2 },
      scopeVersion: 1,
      mode: 'RECON',
    };
    expect(actionApprovalHash(base)).not.toBe(
      actionApprovalHash({ ...base, arguments: { ...base.arguments, depth: 3 } }),
    );
    expect(actionApprovalHash(base)).not.toBe(actionApprovalHash({ ...base, scopeVersion: 2 }));
  });
});
