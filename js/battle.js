// Skelesquat boss battle rules. Pure logic, no DOM — unit-tested in tests/.
//
// The battle never detects movement itself: it only receives the 'rep'
// events that the existing RepLens ExerciseTracker already emits.

/** Campaign content. Only one encounter exists. */
export const CAMPAIGN = Object.freeze({
  level: 1,
  boss: 'Skelesquat',
});

/**
 * Rep goals per existing RepLens exercise for one battle (typical single-set
 * counts for an average adult). The four workouts are exactly the four
 * exercises RepLens already tracks.
 */
export const BATTLE_GOALS = Object.freeze({ squat: 15, pushup: 10, curl: 12, press: 10 });

export const ATTACK_EVERY = 4;        // reps grouped into one attack animation
export const MOTIVATE_EVERY = 5;      // valid reps between motivational lines
export const INTERVAL_SECONDS = 5;    // rest between workouts

/**
 * Boss max HP from today's MealBase calories:
 *   clamp(100 + kcal / 10, 100, 350), rounded.
 * Missing / invalid / negative calorie data → 100 HP (never 0).
 * HP only sets how big the health bar's numbers are — the workout length is
 * always the fixed rep goals above, whatever was eaten.
 */
export function bossMaxHp(kcal) {
  const k = Number.isFinite(kcal) && kcal > 0 ? kcal : 0;
  return Math.round(Math.min(350, Math.max(100, 100 + k / 10)));
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffle(list, rand = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Battle {
  /**
   * @param {object} o
   * @param {number} o.maxHp        locked for the whole battle
   * @param {string[]} o.order      exercise ids in battle order
   * @param {object} o.goals        reps per exercise id
   */
  constructor({ maxHp, order, goals = BATTLE_GOALS, attackEvery = ATTACK_EVERY, motivateEvery = MOTIVATE_EVERY }) {
    if (!(maxHp > 0)) throw new Error('maxHp must be positive');
    if (!order?.length) throw new Error('order required');
    this.maxHp = maxHp;
    this.order = order.slice();
    this.goals = order.map((id) => {
      const g = goals[id];
      if (!(g > 0)) throw new Error(`no goal for ${id}`);
      return g;
    });
    this.totalPlanned = this.goals.reduce((s, g) => s + g, 0);
    this.damagePerRep = maxHp / this.totalPlanned;
    this.attackEvery = attackEvery;
    this.motivateEvery = motivateEvery;
    this.index = 0;          // current workout position (0-based)
    this.workoutReps = 0;    // valid reps in the current workout
    this.totalReps = 0;      // valid reps across the battle
    this.pending = 0;        // reps not yet shown as an attack
    this.phase = 'ready';    // ready | active | interval | won | ended
  }

  get exercise() { return this.order[this.index]; }
  get goal() { return this.goals[this.index]; }
  get isLast() { return this.index === this.order.length - 1; }

  /**
   * Remaining HP. Derived from the rep count rather than accumulated, so
   * rounding can never drift: the final planned rep lands on exactly 0.
   */
  get hp() {
    if (this.totalReps >= this.totalPlanned) return 0;
    return Math.max(0, this.maxHp * (1 - this.totalReps / this.totalPlanned));
  }

  /** HP for display: never shows 0 before the final rep. */
  get hpDisplay() {
    const h = this.hp;
    return h === 0 ? 0 : Math.max(1, Math.ceil(h - 1e-9));
  }

  start() {
    if (this.phase === 'ready') this.phase = 'active';
  }

  /**
   * Register one valid rep from the existing tracker.
   * Reps are ignored outside the active phase (countdown, interval, after
   * the win) and beyond the current workout's goal.
   */
  registerRep() {
    if (this.phase !== 'active' || this.workoutReps >= this.goal) return { accepted: false };
    this.workoutReps += 1;
    this.totalReps += 1;
    this.pending += 1;
    const workoutDone = this.workoutReps >= this.goal;
    let attackReps = 0;
    if (this.pending >= this.attackEvery || (workoutDone && this.pending > 0)) {
      attackReps = this.pending;
      this.pending = 0;
    }
    let battleWon = false;
    if (workoutDone) {
      if (this.isLast) { this.phase = 'won'; battleWon = true; } else { this.phase = 'interval'; }
    }
    return {
      accepted: true,
      hp: this.hp,
      attack: attackReps > 0,
      attackDamage: attackReps * this.damagePerRep,
      workoutDone,
      battleWon,
      halfway: !workoutDone && this.workoutReps === Math.floor(this.goal / 2),
      motivational: this.totalReps % this.motivateEvery === 0,
      workoutReps: this.workoutReps,
      goal: this.goal,
    };
  }

  /** After the 5-second interval: move to the next workout. */
  nextWorkout() {
    if (this.phase !== 'interval') return false;
    this.index += 1;
    this.workoutReps = 0;
    this.pending = 0;
    this.phase = 'active';
    return true;
  }

  /** Player retreats: the battle stops without a win. */
  end() {
    if (this.phase !== 'won') this.phase = 'ended';
  }
}
