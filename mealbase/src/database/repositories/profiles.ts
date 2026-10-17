import type { Db } from '../connection';
import { newId, nowIso, parseJson } from '../connection';
import type { UserPreferences } from '../../shared/types/api';
import { DEFAULT_PLANNER_PREFERENCES, type PlannerPreferences } from '../../shared/types/planning';

export interface ProfileRow {
  id: string;
  display_name: string;
  email: string | null;
  password_hash: string | null;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export class ProfileRepository {
  constructor(private readonly db: Db) {}

  get(id: string): ProfileRow | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | undefined;
  }

  findByEmail(email: string): ProfileRow | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE email = ?').get(email.trim()) as ProfileRow | undefined;
  }

  create(input: { id?: string; displayName: string; email?: string | null; passwordHash?: string | null; timezone?: string }): ProfileRow {
    const id = input.id ?? newId();
    const ts = nowIso();
    this.db
      .prepare('INSERT INTO profiles (id, display_name, email, password_hash, timezone, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.displayName, input.email?.trim() ?? null, input.passwordHash ?? null, input.timezone ?? 'UTC', ts, ts);
    return this.get(id)!;
  }

  ensure(id: string, displayName: string): ProfileRow {
    return this.get(id) ?? this.create({ id, displayName });
  }

  update(id: string, patch: { displayName?: string; timezone?: string }): void {
    const p = this.get(id);
    if (!p) return;
    this.db
      .prepare('UPDATE profiles SET display_name = ?, timezone = ?, updated_at = ? WHERE id = ?')
      .run(patch.displayName ?? p.display_name, patch.timezone ?? p.timezone, nowIso(), id);
  }

  // ---- sessions ----
  createSession(tokenHash: string, profileId: string, expiresAt: Date): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, profile_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run(tokenHash, profileId, nowIso(), expiresAt.toISOString());
  }

  findSession(tokenHash: string): { profile_id: string; expires_at: string } | undefined {
    return this.db.prepare('SELECT profile_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as any;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  }

  // ---- identity links (host app user → profile) ----
  resolveIdentity(provider: string, externalId: string, displayName: string): ProfileRow {
    const row = this.db
      .prepare('SELECT profile_id FROM identity_links WHERE provider = ? AND external_id = ?')
      .get(provider, externalId) as { profile_id: string } | undefined;
    if (row) return this.get(row.profile_id)!;
    const profile = this.create({ displayName });
    this.db
      .prepare('INSERT INTO identity_links (provider, external_id, profile_id, created_at) VALUES (?,?,?,?)')
      .run(provider, externalId, profile.id, nowIso());
    return profile;
  }
}

interface PrefRow {
  daily_calorie_target: number | null;
  adult_confirmed: number;
  planner_json: string;
  updated_at: string;
}

export class PreferencesRepository {
  constructor(private readonly db: Db) {}

  get(profileId: string, timezone: string): UserPreferences {
    const row = this.db.prepare('SELECT * FROM user_preferences WHERE profile_id = ?').get(profileId) as PrefRow | undefined;
    if (!row) {
      return { dailyCalorieTarget: null, adultConfirmed: false, timezone, planner: { ...DEFAULT_PLANNER_PREFERENCES }, updatedAt: null };
    }
    return {
      dailyCalorieTarget: row.daily_calorie_target,
      adultConfirmed: row.adult_confirmed === 1,
      timezone,
      planner: { ...DEFAULT_PLANNER_PREFERENCES, ...parseJson<Partial<PlannerPreferences>>(row.planner_json, {}) },
      updatedAt: row.updated_at,
    };
  }

  save(profileId: string, prefs: Omit<UserPreferences, 'timezone' | 'updatedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO user_preferences (profile_id, daily_calorie_target, adult_confirmed, planner_json, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(profile_id) DO UPDATE SET daily_calorie_target = excluded.daily_calorie_target,
           adult_confirmed = excluded.adult_confirmed, planner_json = excluded.planner_json, updated_at = excluded.updated_at`,
      )
      .run(profileId, prefs.dailyCalorieTarget, prefs.adultConfirmed ? 1 : 0, JSON.stringify(prefs.planner), nowIso());
  }
}
