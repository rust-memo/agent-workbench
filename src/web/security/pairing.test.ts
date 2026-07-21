import { describe, expect, it } from 'vitest';
import { PairingManager } from './pairing.js';

describe('PairingManager', () => {
  it('uses a single-use token and creates an authenticated CSRF-bound session', () => {
    const manager = new PairingManager();
    expect(manager.pair('wrong')).toBeUndefined();
    const paired = manager.pair(manager.rawPairingToken);
    expect(paired).toBeDefined();
    if (!paired) throw new Error('pairing unexpectedly failed');
    expect(manager.pair(manager.rawPairingToken)).toBeUndefined();
    const cookie = manager.cookie(paired.sessionId);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(manager.authenticate(cookie)?.sessionId).toBe(paired.sessionId);
    expect(manager.verifyCsrf(paired.sessionId, paired.csrfToken)).toBe(true);
    expect(manager.verifyCsrf(paired.sessionId, 'wrong')).toBe(false);
  });
});
