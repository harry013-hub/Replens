/**
 * Schema migrations. Append new entries; never edit an applied one.
 * Applied ids are recorded in `schema_migrations`.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_initial',
    sql: `
CREATE TABLE profiles (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  email         TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_profile ON sessions(profile_id);

-- Maps identities from a host application (e.g. the workout app) to MealBase profiles.
CREATE TABLE identity_links (
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  profile_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (provider, external_id)
);

CREATE TABLE user_preferences (
  profile_id            TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  daily_calorie_target  REAL CHECK (daily_calorie_target IS NULL OR daily_calorie_target > 0),
  adult_confirmed       INTEGER NOT NULL DEFAULT 0,
  planner_json          TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Foods: cached provider foods (owner NULL), user manual foods (owner set), dev sample foods.
CREATE TABLE foods (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL CHECK (source IN ('usda','manual','sample')),
  source_food_id    TEXT,
  owner_profile_id  TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  brand             TEXT,
  data_type         TEXT,
  ref_quantity      REAL NOT NULL CHECK (ref_quantity > 0),
  ref_unit          TEXT NOT NULL CHECK (ref_unit IN ('g','ml','piece','serving')),
  ref_unit_label    TEXT,
  calories          REAL,
  protein_g         REAL,
  carbs_g           REAL,
  fat_g             REAL,
  attribution       TEXT,
  notes_json        TEXT NOT NULL DEFAULT '[]',
  fetched_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX foods_shared_source ON foods(source, source_food_id)
  WHERE owner_profile_id IS NULL AND source_food_id IS NOT NULL;
CREATE INDEX foods_owner ON foods(owner_profile_id);

CREATE TABLE food_servings (
  id                TEXT PRIMARY KEY,
  food_id           TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  owner_profile_id  TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  unit_key          TEXT,
  ref_amount        REAL NOT NULL CHECK (ref_amount > 0),
  source            TEXT NOT NULL CHECK (source IN ('provider','user','sample')),
  sort_order        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX food_servings_food ON food_servings(food_id);

CREATE TABLE recipes (
  id                TEXT PRIMARY KEY,
  owner_profile_id  TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  seed_key          TEXT UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT,
  meal_types_json   TEXT NOT NULL,
  prep_minutes      INTEGER NOT NULL CHECK (prep_minutes >= 0),
  budget_level      TEXT NOT NULL CHECK (budget_level IN ('low','medium','high')),
  servings          REAL NOT NULL CHECK (servings > 0),
  instructions_json TEXT NOT NULL DEFAULT '[]',
  is_sample         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX recipes_owner ON recipes(owner_profile_id);

CREATE TABLE recipe_ingredients (
  id                TEXT PRIMARY KEY,
  recipe_id         TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  quantity          REAL CHECK (quantity IS NULL OR quantity > 0),
  unit              TEXT NOT NULL,
  food_id           TEXT REFERENCES foods(id) ON DELETE SET NULL,
  allergens_json    TEXT NOT NULL DEFAULT '[]',
  may_contain_json  TEXT NOT NULL DEFAULT '[]',
  category          TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX recipe_ingredients_recipe ON recipe_ingredients(recipe_id);

CREATE TABLE meal_plans (
  id                TEXT PRIMARY KEY,
  profile_id        TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('draft','saved','replaced')),
  preferences_json  TEXT NOT NULL,
  target_applied    INTEGER NOT NULL DEFAULT 0,
  warnings_json     TEXT NOT NULL DEFAULT '[]',
  seed              INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX meal_plans_profile ON meal_plans(profile_id, week_start);
CREATE UNIQUE INDEX meal_plans_one_saved_per_week ON meal_plans(profile_id, week_start) WHERE status = 'saved';

CREATE TABLE meal_plan_items (
  id                    TEXT PRIMARY KEY,
  plan_id               TEXT NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  date                  TEXT NOT NULL,
  meal_type             TEXT NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner')),
  recipe_id             TEXT REFERENCES recipes(id) ON DELETE SET NULL,
  food_id               TEXT REFERENCES foods(id) ON DELETE SET NULL,
  name                  TEXT NOT NULL,
  servings              REAL NOT NULL CHECK (servings > 0),
  calories              REAL,
  protein_g             REAL,
  carbs_g               REAL,
  fat_g                 REAL,
  recipe_snapshot_json  TEXT NOT NULL,
  notes                 TEXT,
  locked                INTEGER NOT NULL DEFAULT 0,
  flags_json            TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (plan_id, date, meal_type)
);

CREATE TABLE food_log_entries (
  id                   TEXT PRIMARY KEY,
  profile_id           TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  local_date           TEXT NOT NULL,
  meal_type            TEXT NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner','snack')),
  food_id              TEXT REFERENCES foods(id) ON DELETE SET NULL,
  recipe_id            TEXT REFERENCES recipes(id) ON DELETE SET NULL,
  display_name         TEXT NOT NULL,
  quantity             REAL NOT NULL CHECK (quantity > 0),
  unit                 TEXT NOT NULL,
  unit_label           TEXT NOT NULL,
  calories             REAL,
  protein_g            REAL,
  carbs_g              REAL,
  fat_g                REAL,
  snapshot_json        TEXT NOT NULL,
  source_plan_item_id  TEXT REFERENCES meal_plan_items(id) ON DELETE SET NULL,
  idempotency_key      TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX food_log_profile_date ON food_log_entries(profile_id, local_date);
CREATE INDEX food_log_plan_item ON food_log_entries(source_plan_item_id);
CREATE UNIQUE INDEX food_log_idempotency ON food_log_entries(profile_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`,
  },
];
