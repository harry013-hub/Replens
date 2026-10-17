import type { Db } from '../connection';
import { newId, nowIso, parseJson } from '../connection';
import type { Food, FoodSource, ReferenceUnit, ServingOption } from '../../shared/types/nutrition';
import type { ProviderFood } from '../../services/food-provider/types';

interface FoodRow {
  id: string;
  source: FoodSource;
  source_food_id: string | null;
  owner_profile_id: string | null;
  name: string;
  brand: string | null;
  data_type: string | null;
  ref_quantity: number;
  ref_unit: ReferenceUnit;
  ref_unit_label: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  attribution: string | null;
}

interface ServingRow {
  id: string;
  food_id: string;
  label: string;
  unit_key: string | null;
  ref_amount: number;
  source: ServingOption['source'];
}

export class FoodRepository {
  constructor(private readonly db: Db) {}

  private servingsFor(foodIds: string[], profileId: string | null): Map<string, ServingOption[]> {
    const map = new Map<string, ServingOption[]>();
    if (!foodIds.length) return map;
    const placeholders = foodIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM food_servings WHERE food_id IN (${placeholders})
         AND (owner_profile_id IS NULL OR owner_profile_id = ?) ORDER BY sort_order, label`,
      )
      .all(...foodIds, profileId) as unknown as ServingRow[];
    for (const r of rows) {
      if (!map.has(r.food_id)) map.set(r.food_id, []);
      map.get(r.food_id)!.push({ id: r.id, label: r.label, unitKey: r.unit_key, refAmount: r.ref_amount, source: r.source });
    }
    return map;
  }

  private toFood(row: FoodRow, servings: ServingOption[]): Food {
    return {
      id: row.id,
      source: row.source,
      sourceFoodId: row.source_food_id,
      name: row.name,
      brand: row.brand,
      dataType: row.data_type,
      reference: {
        quantity: row.ref_quantity,
        unit: row.ref_unit,
        unitLabel: row.ref_unit_label,
        values: { calories: row.calories, proteinG: row.protein_g, carbsG: row.carbs_g, fatG: row.fat_g },
      },
      servings,
      isSample: row.source === 'sample',
      attribution: row.attribution,
    };
  }

  /** A food the profile may see: shared foods and the profile's own manual foods. */
  getVisible(id: string, profileId: string): Food | null {
    const row = this.db
      .prepare('SELECT * FROM foods WHERE id = ? AND (owner_profile_id IS NULL OR owner_profile_id = ?)')
      .get(id, profileId) as FoodRow | undefined;
    if (!row) return null;
    return this.toFood(row, this.servingsFor([id], profileId).get(id) ?? []);
  }

  /** Load many foods by id (used for recipe nutrition). */
  getMany(ids: string[], profileId: string | null): Map<string, Food> {
    const out = new Map<string, Food>();
    const unique = [...new Set(ids)];
    if (!unique.length) return out;
    const rows = this.db
      .prepare(
        `SELECT * FROM foods WHERE id IN (${unique.map(() => '?').join(',')})
         AND (owner_profile_id IS NULL OR owner_profile_id = ?)`,
      )
      .all(...unique, profileId) as unknown as FoodRow[];
    const servings = this.servingsFor(rows.map((r) => r.id), profileId);
    for (const r of rows) out.set(r.id, this.toFood(r, servings.get(r.id) ?? []));
    return out;
  }

  findShared(source: FoodSource, sourceFoodId: string): Food | null {
    const row = this.db
      .prepare('SELECT * FROM foods WHERE source = ? AND source_food_id = ? AND owner_profile_id IS NULL')
      .get(source, sourceFoodId) as FoodRow | undefined;
    return row ? this.toFood(row, this.servingsFor([row.id], null).get(row.id) ?? []) : null;
  }

  /** Insert or refresh a provider food. Log entries keep their own snapshots, so refreshing is safe. */
  upsertProviderFood(p: ProviderFood): string {
    const existing = this.db
      .prepare("SELECT id FROM foods WHERE source = 'usda' AND source_food_id = ? AND owner_profile_id IS NULL")
      .get(p.sourceFoodId) as { id: string } | undefined;
    const ts = nowIso();
    const v = p.reference.values;
    let id: string;
    if (existing) {
      id = existing.id;
      this.db
        .prepare(
          `UPDATE foods SET name=?, brand=?, data_type=?, ref_quantity=?, ref_unit=?, calories=?, protein_g=?, carbs_g=?, fat_g=?,
           attribution=?, notes_json=?, fetched_at=?, updated_at=? WHERE id=?`,
        )
        .run(p.name, p.brand, p.dataType, p.reference.quantity, p.reference.unit, v.calories, v.proteinG, v.carbsG, v.fatG,
          p.attribution, JSON.stringify(p.notes), ts, ts, id);
      this.db.prepare("DELETE FROM food_servings WHERE food_id = ? AND source = 'provider'").run(id);
    } else {
      id = newId();
      this.db
        .prepare(
          `INSERT INTO foods (id, source, source_food_id, owner_profile_id, name, brand, data_type, ref_quantity, ref_unit, ref_unit_label,
            calories, protein_g, carbs_g, fat_g, attribution, notes_json, fetched_at, created_at, updated_at)
           VALUES (?, 'usda', ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, p.sourceFoodId, p.name, p.brand, p.dataType, p.reference.quantity, p.reference.unit,
          v.calories, v.proteinG, v.carbsG, v.fatG, p.attribution, JSON.stringify(p.notes), ts, ts, ts);
    }
    const ins = this.db.prepare(
      `INSERT INTO food_servings (id, food_id, owner_profile_id, label, unit_key, ref_amount, source, sort_order) VALUES (?,?,NULL,?,?,?,?,?)`,
    );
    p.servings.forEach((s, i) => ins.run(newId(), id, s.label, s.unitKey, s.refAmount, 'provider', i));
    return id;
  }

  createManual(profileId: string, input: {
    name: string; brand: string | null; refQuantity: number; refUnit: ReferenceUnit; unitLabel: string | null;
    calories: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null;
  }): string {
    const id = newId();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO foods (id, source, source_food_id, owner_profile_id, name, brand, data_type, ref_quantity, ref_unit, ref_unit_label,
          calories, protein_g, carbs_g, fat_g, attribution, notes_json, fetched_at, created_at, updated_at)
         VALUES (?, 'manual', NULL, ?, ?, ?, 'Manual entry', ?, ?, ?, ?, ?, ?, ?, 'Entered by you', '[]', NULL, ?, ?)`,
      )
      .run(id, profileId, input.name, input.brand, input.refQuantity, input.refUnit, input.unitLabel,
        input.calories, input.proteinG, input.carbsG, input.fatG, ts, ts);
    return id;
  }

  addUserServing(foodId: string, profileId: string, label: string, refAmount: number, unitKey: string | null): ServingOption {
    const id = newId();
    this.db
      .prepare(`INSERT INTO food_servings (id, food_id, owner_profile_id, label, unit_key, ref_amount, source, sort_order) VALUES (?,?,?,?,?,?,'user',100)`)
      .run(id, foodId, profileId, label, unitKey, refAmount);
    return { id, label, unitKey, refAmount, source: 'user' };
  }

  searchManual(profileId: string, query: string, limit = 10): Food[] {
    const rows = this.db
      .prepare(`SELECT * FROM foods WHERE source = 'manual' AND owner_profile_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`)
      .all(profileId, likePattern(query), limit) as unknown as FoodRow[];
    const servings = this.servingsFor(rows.map((r) => r.id), profileId);
    return rows.map((r) => this.toFood(r, servings.get(r.id) ?? []));
  }

  searchSample(query: string, limit = 10): Food[] {
    const rows = this.db
      .prepare(`SELECT * FROM foods WHERE source = 'sample' AND owner_profile_id IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`)
      .all(likePattern(query), limit) as unknown as FoodRow[];
    const servings = this.servingsFor(rows.map((r) => r.id), null);
    return rows.map((r) => this.toFood(r, servings.get(r.id) ?? []));
  }

  /** Recently logged foods for quick re-use. */
  recentForProfile(profileId: string, limit = 12): Food[] {
    const ids = (this.db
      .prepare(`SELECT food_id, MAX(created_at) AS last FROM food_log_entries WHERE profile_id = ? AND food_id IS NOT NULL
                GROUP BY food_id ORDER BY last DESC LIMIT ?`)
      .all(profileId, limit) as Array<{ food_id: string }>).map((r) => r.food_id);
    const map = this.getMany(ids, profileId);
    return ids.map((id) => map.get(id)).filter((f): f is Food => Boolean(f));
  }

  deleteManualForProfile(profileId: string): void {
    this.db.prepare("DELETE FROM foods WHERE owner_profile_id = ?").run(profileId);
    this.db.prepare('DELETE FROM food_servings WHERE owner_profile_id = ?').run(profileId);
  }

  notesFor(id: string): string[] {
    const r = this.db.prepare('SELECT notes_json FROM foods WHERE id = ?').get(id) as { notes_json: string } | undefined;
    return parseJson<string[]>(r?.notes_json, []);
  }
}

function likePattern(q: string): string {
  return `%${q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}
