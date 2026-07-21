import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

interface BrowserSession {
  csrfToken: string;
  createdAt: number;
}

export class PairingManager {
  private readonly pairingHash: Buffer;
  private pairingUsed = false;
  private readonly expiresAt: number;
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(private readonly ttlMs = 5 * 60_000) {
    this.rawPairingToken = randomBytes(32).toString('base64url');
    this.pairingHash = digest(this.rawPairingToken);
    this.expiresAt = Date.now() + ttlMs;
  }

  readonly rawPairingToken: string;

  pair(token: string): { sessionId: string; csrfToken: string } | undefined {
    if (this.pairingUsed || Date.now() > this.expiresAt) return undefined;
    const candidate = digest(token);
    if (
      candidate.length !== this.pairingHash.length ||
      !timingSafeEqual(candidate, this.pairingHash)
    )
      return undefined;
    this.pairingUsed = true;
    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    this.sessions.set(sessionId, { csrfToken, createdAt: Date.now() });
    return { sessionId, csrfToken };
  }

  authenticate(
    cookieHeader: string | undefined,
  ): { sessionId: string; csrfToken: string } | undefined {
    const sessionId = parseCookies(cookieHeader).pf_session;
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    return session ? { sessionId, csrfToken: session.csrfToken } : undefined;
  }

  verifyCsrf(sessionId: string, token: string | undefined): boolean {
    const expected = this.sessions.get(sessionId)?.csrfToken;
    if (!expected || !token) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  cookie(sessionId: string): string {
    return `pf_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      /* ignore malformed cookies */
    }
  }
  return out;
}
