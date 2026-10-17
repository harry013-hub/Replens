import { useState } from 'react';
import type { DailySummary, FoodLogEntry, MealType } from '../../../shared/types/nutrition';
import { MEAL_TYPES } from '../../../shared/types/nutrition';
import { addDays, formatLocalDate, isLocalDate, startOfWeek, weekDates } from '../../../shared/lib/dates';
import { formatNumber, formatNutrient, isValidQuantity, referenceUnitLabel } from '../../../shared/lib/nutrition';
import { Button, ConfirmDialog, Dialog, Field, Icon, Notice, NutrientList, Spinner } from '../../../shared/ui';
import { Link, useNutrition } from '../app-context';
import { errorMessage, MEAL_LABELS, todayLocal, useAsync } from '../hooks';

export function TodayPage() {
  const { api, me, query, navigate, config } = useNutrition();
  const today = todayLocal(me.timezone);
  const qDate = query.get('date');
  const date = qDate && isLocalDate(qDate) ? qDate : today;
  const setDate = (d: string) => navigate(d === today ? '/' : `/?date=${d}`, { replace: true });

  const summary = useAsync(() => api.summary(date), [date]);
  const [editing, setEditing] = useState<FoodLogEntry | null>(null);
  const [deleting, setDeleting] = useState<FoodLogEntry | null>(null);

  return (
    <div className="mb-page">
      <div className="mb-page-head">
        <div>
          <h1>{date === today ? 'Today' : formatLocalDate(date, { weekday: 'long' })}</h1>
          <p className="mb-muted">{formatLocalDate(date, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        {date !== today ? <Button size="sm" onClick={() => setDate(today)}>Back to today</Button> : null}
      </div>

      {config.persistence === 'memory' ? (
        <Notice tone="warn">This browser can't save data (for example Private Browsing). You can log food, but it disappears when you close the page.</Notice>
      ) : null}

      <DateStrip date={date} today={today} onChange={setDate} />

      {summary.loading && !summary.data ? <Spinner label="Loading your day" /> : null}
      {summary.error ? (
        <Notice tone="error" title="Couldn't load this day">
          {summary.error.message}
          <div><Button size="sm" onClick={summary.reload}>Retry</Button></div>
        </Notice>
      ) : null}

      {summary.data ? (
        <>
          <Totals summary={summary.data} />
          <WorkoutConnection date={date} />
          <section aria-label="Meals" className="mb-stack-lg">
            {MEAL_TYPES.map((m) => (
              <MealSection
                key={m}
                summary={summary.data!}
                mealType={m}
                onAdd={() => navigate(`/search?meal=${m}&date=${date}`)}
                onEdit={setEditing}
                onDelete={setDeleting}
              />
            ))}
          </section>
          <p><Link to="/plan">View weekly meal plan</Link></p>
          <p className="mb-footnote">
            Calories and nutrients are estimates based on the food and portion you chose. MealBase does not give individual
            medical or nutrition advice.
          </p>
        </>
      ) : null}

      <EditEntryDialog entry={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); summary.reload(); }} />
      <DeleteEntryDialog entry={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); summary.reload(); }} />
    </div>
  );
}

function DateStrip({ date, today, onChange }: { date: string; today: string; onChange: (d: string) => void }) {
  const days = weekDates(startOfWeek(date));
  return (
    <div className="mb-datestrip">
      <Button variant="quiet" className="mb-icon-btn" aria-label="Previous week" onClick={() => onChange(addDays(date, -7))}><Icon name="left" /></Button>
      <div className="mb-days" role="group" aria-label="Choose a day">
        {days.map((d) => (
          <button
            key={d}
            type="button"
            className="mb-day"
            aria-pressed={d === date}
            data-today={d === today}
            aria-label={`${formatLocalDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}${d === today ? ' (today)' : ''}`}
            onClick={() => onChange(d)}
          >
            <span>{formatLocalDate(d, { weekday: 'narrow' })}</span>
            <strong>{formatLocalDate(d, { day: 'numeric' })}</strong>
          </button>
        ))}
      </div>
      <Button variant="quiet" className="mb-icon-btn" aria-label="Next week" onClick={() => onChange(addDays(date, 7))}><Icon name="right" /></Button>
    </div>
  );
}

function Totals({ summary }: { summary: DailySummary }) {
  // An empty day sums to zero; items that lack data are still reported separately.
  const t = summary.totals.itemCount === 0
    ? { ...summary.totals, calories: 0, proteinG: 0, carbsG: 0, fatG: 0 }
    : summary.totals;
  const target = summary.dailyCalorieTarget;
  return (
    <section className="mb-panel mb-stack" aria-labelledby="mb-totals">
      <h2 id="mb-totals" className="mb-sr-only">Daily totals</h2>
      <div className="mb-row-between" style={{ alignItems: 'end' }}>
        <div className="mb-tally">
          <span className="mb-muted mb-small">Logged</span>
          <span className="mb-tally-number">
            {t.calories === null ? '—' : formatNumber(Math.round(t.calories))}
            <span className="mb-tally-unit">kcal</span>
          </span>
        </div>
        {target ? (
          <div className="mb-tally" style={{ textAlign: 'right' }}>
            <span className="mb-muted mb-small">Daily target</span>
            <span className="mb-num" style={{ fontSize: 'var(--mb-text-lg)', fontWeight: 700 }}>{formatNumber(target)} kcal</span>
          </div>
        ) : null}
      </div>
      {t.itemCount === 0 ? <p className="mb-muted mb-small">Nothing logged yet. Logging is optional — add what's useful to you.</p> : null}
      {t.missing.calories > 0 ? <p className="mb-hint">{t.missing.calories} logged {t.missing.calories === 1 ? 'item has' : 'items have'} no calorie data and {t.missing.calories === 1 ? 'is' : 'are'} not included.</p> : null}
      <NutrientList values={t} totals compact />
    </section>
  );
}

function WorkoutConnection({ date }: { date: string }) {
  const { config } = useNutrition();
  const w = config.workout;
  return (
    <section className="mb-panel mb-workout" data-configured={w.configured} aria-label="Workout connection">
      <div className="mb-row">
        <Icon name="dumbbell" />
        <div>
          <strong>{w.label}</strong>
          <p className="mb-small mb-muted">
            {w.configured ? 'Open your workout app. Logging food first is optional.' : 'Workout connection not configured'}
          </p>
        </div>
      </div>
      {w.configured && w.url ? (
        <a className="mb-btn" href={`${w.url}${w.url.includes('?') ? '&' : '?'}date=${date}`}>Open {w.label}</a>
      ) : null}
    </section>
  );
}

function MealSection({ summary, mealType, onAdd, onEdit, onDelete }: {
  summary: DailySummary; mealType: MealType; onAdd: () => void; onEdit: (e: FoodLogEntry) => void; onDelete: (e: FoodLogEntry) => void;
}) {
  const meal = summary.meals.find((m) => m.mealType === mealType)!;
  const headingId = `mb-meal-${mealType}`;
  return (
    <section className="mb-meal" aria-labelledby={headingId}>
      <div className="mb-meal-head">
        <h2 id={headingId}>{MEAL_LABELS[mealType]}</h2>
        <span className="mb-muted mb-num">{meal.entries.length ? formatNutrient(meal.totals.calories, 'calories') : ''}</span>
      </div>
      {meal.entries.length ? (
        <ul className="mb-plain">
          {meal.entries.map((e) => (
            <li key={e.id} className="mb-entry">
              <div>
                <div className="mb-entry-name">{e.displayName}</div>
                <div className="mb-small mb-muted">
                  {formatNumber(e.quantity, 2)} {e.unitLabel} · <span className="mb-num">{formatNutrient(e.nutrition.calories, 'calories')}</span>
                  {e.snapshot?.isSample ? <> · <span className="mb-badge mb-badge-sample">Sample data</span></> : null}
                  {e.sourcePlanItemId ? <> · <span className="mb-badge">From plan</span></> : null}
                </div>
              </div>
              <div className="mb-entry-actions">
                <Button variant="quiet" className="mb-icon-btn" aria-label={`Edit ${e.displayName}`} onClick={() => onEdit(e)}><Icon name="edit" /></Button>
                <Button variant="quiet" className="mb-icon-btn mb-btn-danger" aria-label={`Delete ${e.displayName}`} onClick={() => onDelete(e)}><Icon name="trash" /></Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div><Button onClick={onAdd}><Icon name="plus" />Add food</Button></div>
    </section>
  );
}

function EditEntryDialog({ entry, onClose, onSaved }: { entry: FoodLogEntry | null; onClose: () => void; onSaved: () => void }) {
  const { api, toast } = useNutrition();
  const [qty, setQty] = useState('');
  const [meal, setMeal] = useState<MealType>('breakfast');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);

  if (entry && entry.id !== lastId) {
    setLastId(entry.id);
    setQty(String(entry.quantity));
    setMeal(entry.mealType);
    setDate(entry.localDate);
    setError(null);
  }

  const q = Number(qty);
  const valid = isValidQuantity(q) && isLocalDate(date);
  const perUnit = entry && entry.quantity > 0 && entry.nutrition.calories !== null ? entry.nutrition.calories / entry.quantity : null;

  async function save() {
    if (!entry || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateLog(entry.id, {
        ...(q !== entry.quantity ? { quantity: q } : {}),
        ...(meal !== entry.mealType ? { mealType: meal } : {}),
        ...(date !== entry.localDate ? { localDate: date } : {}),
      });
      toast('Entry updated');
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(entry)} title={entry ? `Edit ${entry.displayName}` : 'Edit'} onClose={() => { setLastId(null); onClose(); }} footer={<>
      <Button onClick={() => { setLastId(null); onClose(); }}>Cancel</Button>
      <Button variant="primary" busy={busy} disabled={!valid} onClick={save}>Save changes</Button>
    </>}>
      {entry ? (
        <div className="mb-stack">
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field label={`Amount (${entry.unitLabel})`} error={qty && !isValidQuantity(q) ? 'Enter an amount greater than 0.' : null}
            hint={`Nutrition is based on ${formatNumber(entry.snapshot.reference.quantity, 2)} ${referenceUnitLabel(entry.snapshot.reference)} from the original entry.`}>
            {(id, d) => <input id={id} aria-describedby={d} className="mb-input" inputMode="decimal" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={qty !== '' && !isValidQuantity(q)} />}
          </Field>
          <div className="mb-grid-2">
            <Field label="Meal">{(id) => (
              <select id={id} className="mb-select" value={meal} onChange={(e) => setMeal(e.target.value as MealType)}>
                {MEAL_TYPES.map((m) => <option key={m} value={m}>{MEAL_LABELS[m]}</option>)}
              </select>
            )}</Field>
            <Field label="Date">{(id) => <input id={id} className="mb-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          </div>
          {perUnit !== null && isValidQuantity(q) ? <p className="mb-small">Estimated: <strong className="mb-num">{formatNutrient(perUnit * q, 'calories')}</strong></p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function DeleteEntryDialog({ entry, onClose, onDeleted }: { entry: FoodLogEntry | null; onClose: () => void; onDeleted: () => void }) {
  const { api, toast } = useNutrition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open={Boolean(entry)}
      title="Delete this entry?"
      danger
      busy={busy}
      confirmLabel="Delete entry"
      onClose={() => { setError(null); onClose(); }}
      onConfirm={async () => {
        if (!entry) return;
        setBusy(true);
        try {
          await api.deleteLog(entry);
          toast('Entry deleted');
          onDeleted();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
      body={<>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p>{entry?.displayName} will be removed from {entry ? MEAL_LABELS[entry.mealType].toLowerCase() : ''}.</p>
      </>}
    />
  );
}
