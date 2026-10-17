/**
 * Authentication behind a replaceable interface.
 *
 * AuthProvider.resolve(req) returns the current profile or null. The rest of
 * the server only ever sees `AuthContext.profileId`; it never trusts a
 * profile id sent by the browser.
 *
 * Built-in providers:
 * - LocalAuthProvider      single-user local demo (AUTH_MODE=local)
 * - SessionAuthProvider    email + password accounts with httpOnly session cookies (AUTH_MODE=accounts)
 * - ServiceTokenProvider   server-to-server calls from a host app (INTEGRATION_SERVICE_TOKEN)
 *
 * To plug in the workout app's own login, implement AuthProvider (e.g. verify
 * its JWT) and map its user id with ProfileRepository.resolveIdentity().
 */
import type { IncomingMessage } from 'node:http';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { ProfileRepository } from '../../database/repositories/profiles';
import { HttpError, parseCookies, type AuthContext } from '../http/router';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'mealbase_session';
export const LOCAL_PROFILE_ID = 'local-user';

export interface AuthProvider {
  /** Return the authenticated profile, null when no credentials, or throw HttpError (e.g. expired). */
  resolve(req: IncomingMessage): AuthContext | null;
}

export class LocalAuthProvider implements AuthProvider {
  constructor(private readonly profiles: ProfileRepository) {
    this.profiles.ensure(LOCAL_PROFILE_ID, 'Me');
  }
  resolve(): AuthContext {
    return { profileId: LOCAL_PROFILE_ID, via: 'local' };
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionAuthProvider implements AuthProvider {
  constructor(private readonly profiles: ProfileRepository, private readonly ttlHours: number) {}

  resolve(req: IncomingMessage): AuthContext | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = this.profiles.findSession(tokenHash);
    if (!session || new Date(session.expires_at).getTime() < Date.now()) {
      if (session) this.profiles.deleteSession(tokenHash);
      throw new HttpError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
    }
    return { profileId: session.profile_id, via: 'session', sessionTokenHash: tokenHash };
  }

  createSession(profileId: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlHours * 3600_000);
    this.profiles.createSession(hashToken(token), profileId, expiresAt);
    return { token, expiresAt };
  }
}

export class ServiceTokenProvider implements AuthProvider {
  constructor(private readonly token: string, private readonly profiles: ProfileRepository) {}

  resolve(req: IncomingMessage): AuthContext | null {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const given = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Invalid service token.');
    }
    const externalId = String(req.headers['x-mealbase-user'] ?? '').trim();
    if (!externalId || externalId.length > 200) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Service calls must include the X-MealBase-User header (your user id).');
    }
    const name = String(req.headers['x-mealbase-user-name'] ?? 'Member').slice(0, 100);
    const profile = this.profiles.resolveIdentity('integration', externalId, name);
    return { profileId: profile.id, via: 'service' };
  }
}

/** Tries providers in order; first non-null wins. */
export class CompositeAuthProvider implements AuthProvider {
  constructor(private readonly providers: AuthProvider[]) {}
  resolve(req: IncomingMessage): AuthContext | null {
    for (const p of this.providers) {
      const ctx = p.resolve(req);
      if (ctx) return ctx;
    }
    return null;
  }
}

// ---- passwords (scrypt, built into Node) ----

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(key, expected);
}

/** Simple in-memory limiter for login attempts. */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max = 10, private readonly windowMs = 15 * 60_000) {}
  check(key: string): void {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Wait a few minutes and try again.');
    }
    list.push(now);
    this.hits.set(key, list);
  }
  reset(key: string): void {
    this.hits.delete(key);
  }
}
