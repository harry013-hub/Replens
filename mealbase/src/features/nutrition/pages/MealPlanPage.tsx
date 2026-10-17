import { useEffect, useState } from 'react';
import type { GroceryLine, MealPlan, MealPlanItem, PlannerPreferences } from '../../../shared/types/planning';
import { addDays, formatLocalDate, isLocalDate, nextWeekStart } from '../../../shared/lib/dates';
import { formatNumber, formatNutrient } from '../../../shared/lib/nutrition';
import { Button, ConfirmDialog, Dialog, Field, Notice, Spinner } from '../../../shared/ui';
import { useNutrition } from '../app-context';
import { errorMessage, todayLocal, useAsync } from '../hooks';
import { ApiError, type PlanSummary } from '../api/client';
import { PlanPreferencesForm } from '../components/PlanPreferencesForm';
import { ChooseMealDialog, LogPlannedDialog, MealDetailsDialog, PlanMealCard } from '../components/PlanMeal';
import { RecipeManager } from '../components/RecipeManager';

function rangeLabel(start: string) {
  const end = addDays(start, 6);
  return `${formatLocalDate(start, { weekday: 'short', day: 'numeric', month: 'short' })} – ${formatLocalDate(end, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export function MealPlanPage() {
  const { api, query, navigate } = useNutrition();
  const plans = useAsync(() => api.plans(), []);
  const selectedId = query.get('id');
  const creating = query.get('new') === '1';

  // Default: open the most recent plan, or the setup form when none exist.
  useEffect(() => {
    if (!plans.data || selectedId || creating) return;
    if (plans.data.length) navigate(`/plan?id=${plans.data[0].id}`, { replace: true });
  }, [plans.data, selectedId, creating, navigate]);

  return (
    <div className="mb-page">
      <div className="mb-page-head">
        <h1>Weekly Meal Plan</h1>
        <div className="mb-row">
          {plans.data && plans.data.length ? (
            <select className="mb-select" aria-label="Choose a plan" style={{ width: 'auto' }} value={creating ? '' : selectedId ?? ''}
              onChange={(e) => navigate(e.target.value ? `/plan?id=${e.target.value}` : '/plan?new=1')}>
              {creating ? <option value="">New plan…</option> : null}
              {plans.data.map((p) => <option key={p.id} value={p.id}>{rangeLabel(p.weekStart)} · {p.status === 'saved' ? 'Saved' : 'Draft'}</option>)}
            </select>
          ) : null}
          {!creating ? <Button onClick={() => navigate('/plan?new=1')}>New plan</Button> : null}
        </div>
      </div>

      {plans.loading && !plans.data ? <Spinner label="Loading plans" /> : null}
      {plans.error ? <Notice tone="error">{plans.error.message} <Button size="sm" onClick={plans.reload}>Retry</Button></Notice> : null}

      {plans.data && (creating || !plans.data.length) ? (
        <PlanSetup existing={plans.data} onCreated={(p) => { plans.reload(); navigate(`/plan?id=${p.id}`); }} />
      ) : null}
      {selectedId && !creating ? <PlanView key={selectedId} planId={selectedId} onChanged={plans.reload} onDeleted={() => { plans.reload(); navigate('/plan', { replace: true }); }} /> : null}

      <RecipeManager />
      <p className="mb-footnote">
        Plans are built from the recipe collection; calories are estimates from ingredient records, not verified values.
        Planned meals are not added to your food log until you choose “Log as eaten”. MealBase does not provide individual medical nutrition advice.
      </p>
    </div>
  );
}

function PlanSetup({ existing, onCreated }: { existing: PlanSummary[]; onCreated: (p: MealPlan) => void }) {
  const { api, me, prefs, setPrefs } = useNutrition();
  const [weekStart, setWeekStart] = useState(nextWeekStart(todayLocal(me.timezone)));
  const [p, setP] = useState<PlannerPreferences>(() => ({
    ...prefs.planner,
    mode: prefs.adultConfirmed ? prefs.planner.mode : 'general',
    calorieTarget: prefs.planner.calorieTarget ?? prefs.dailyCalorieTarget,
  }));
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; problems?: string[] } | null>(null);

  const savedSameWeek = existing.find((x) => x.weekStart === weekStart && x.status === 'saved');

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      if (remember) {
        const next = await api.savePreferences({ dailyCalorieTarget: prefs.dailyCalorieTarget, adultConfirmed: prefs.adultConfirmed, timezone: prefs.timezone, planner: p });
        setPrefs(next);
      }
      onCreated(await api.generatePlan({ weekStart, preferences: p }));
    } catch (e) {
      const problems = e instanceof ApiError ? (e.details as { problems?: string[] } | undefined)?.problems : undefined;
      setError({ message: errorMessage(e), problems });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-panel mb-stack-lg" aria-labelledby="mb-setup">
      <h2 id="mb-setup">Plan a week</h2>
      <div className="mb-stack">
        <Field label="Week starting" hint={isLocalDate(weekStart) ? `Plan covers ${rangeLabel(weekStart)}` : 'Choose a start date'}>
          {(id, d) => <input id={id} aria-describedby={d} className="mb-input" type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} style={{ maxWidth: 240 }} />}
        </Field>
        {savedSameWeek ? <Notice tone="info">You already have a saved plan for this week. This creates a new draft; you'll be asked before it replaces the saved one.</Notice> : null}
      </div>
      <PlanPreferencesForm value={p} onChange={setP} adultConfirmed={prefs.adultConfirmed} />
      <label className="mb-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>Remember these preferences</span></label>
      {error ? (
        <Notice tone="error" title={error.message}>
          {error.problems?.length ? <ul>{error.problems.map((x) => <li key={x}>{x}</li>)}</ul> : null}
        </Notice>
      ) : null}
      <div><Button variant="primary" busy={busy} disabled={!isLocalDate(weekStart)} onClick={generate}>Create plan for {isLocalDate(weekStart) ? rangeLabel(weekStart) : 'this week'}</Button></div>
    </section>
  );
}

function PlanView({ planId, onChanged, onDeleted }: { planId: string; onChanged: () => void; onDeleted: () => void }) {
  const { api, toast } = useNutrition();
  const plan = useAsync(() => api.plan(planId), [planId]);
  const [logItem, setLogItem] = useState<MealPlanItem | null>(null);
  const [detailItem, setDetailItem] = useState<MealPlanItem | null>(null);
  const [chooseItem, setChooseItem] = useState<MealPlanItem | null>(null);
  const [confirm, setConfirm] = useState<null | 'regen-week' | 'delete' | 'overwrite'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; problems?: string[] } | null>(null);
  const [grocery, setGrocery] = useState(false);

  if (plan.loading && !plan.data) return <Spinner label="Loading plan" />;
  if (plan.error) return <Notice tone="error" title="Couldn't load this plan">{plan.error.message} <Button size="sm" onClick={plan.reload}>Retry</Button></Notice>;
  const p = plan.data;
  if (!p) return null;

  const update = (next: MealPlan) => plan.setData(next);

  async function act(name: string, fn: () => Promise<MealPlan | void>, done?: string) {
    setBusy(name);
    setError(null);
    try {
      const r = await fn();
      if (r) update(r);
      if (done) toast(done);
      onChanged();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PLAN_EXISTS') {
        setConfirm('overwrite');
        return false;
      }
      const problems = e instanceof ApiError ? (e.details as { problems?: string[] } | undefined)?.problems : undefined;
      setError({ message: errorMessage(e), problems });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const target = p.targetApplied ? p.preferences.calorieTarget : null;
  const days = p.dayTotals;

  return (
    <section className="mb-stack-lg" aria-labelledby="mb-plan-title">
      <div className="mb-panel mb-stack">
        <div className="mb-row-between">
          <div>
            <h2 id="mb-plan-title">{rangeLabel(p.weekStart)}</h2>
            <p className="mb-small mb-muted">
              {p.status === 'saved' ? 'Saved plan' : 'Draft — not saved yet'} · {p.items.length} meals ·{' '}
              {target ? `daily target ${formatNumber(target)} kcal ± ${p.preferences.targetTolerancePct}%` : 'general planning'}
              {p.preferences.people > 1 ? ` · groceries for ${p.preferences.people}` : ''}
            </p>
          </div>
          <span className={`mb-badge ${p.status === 'saved' ? 'mb-badge-accent' : ''}`}>{p.status === 'saved' ? 'Saved' : 'Draft'}</span>
        </div>
        <div className="mb-row">
          {p.status !== 'saved' ? <Button variant="primary" busy={busy === 'save'} onClick={() => act('save', () => api.savePlan(p.id), 'Plan saved')}>Save plan</Button> : null}
          <Button onClick={() => setGrocery(true)}>Grocery list</Button>
          <Button busy={busy === 'regen'} onClick={() => setConfirm('regen-week')}>Regenerate week</Button>
          <Button variant="quiet" className="mb-btn-danger" onClick={() => setConfirm('delete')}>Delete plan</Button>
        </div>
        {p.warnings.length ? <Notice tone="warn"><ul>{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice> : null}
        {error ? <Notice tone="error" title={error.message}>{error.problems?.length ? <ul>{error.problems.map((x) => <li key={x}>{x}</li>)}</ul> : null}</Notice> : null}
      </div>

      {days.map((d) => {
        const items = p.items.filter((i) => i.date === d.date);
        return (
          <section key={d.date} className="mb-plan-day" aria-labelledby={`mb-day-${d.date}`}>
            <div className="mb-plan-day-head">
              <h2 id={`mb-day-${d.date}`}>{formatLocalDate(d.date, { weekday: 'long', day: 'numeric', month: 'short' })}</h2>
              <div className="mb-row">
                <span className="mb-num"><strong>{formatNutrient(d.nutrition.calories, 'calories')}</strong></span>
                {target && d.difference !== null ? (
                  <span className={`mb-badge ${d.withinTolerance ? 'mb-badge-accent' : 'mb-badge-warn'}`}>
                    {d.difference >= 0 ? '+' : '−'}{formatNumber(Math.abs(Math.round(d.difference)))} kcal vs target{d.withinTolerance ? '' : ` (outside ±${p.preferences.targetTolerancePct}%)`}
                  </span>
                ) : null}
                <Button size="sm" variant="quiet" busy={busy === `day-${d.date}`} onClick={() => act(`day-${d.date}`, () => api.regenerate(p.id, 'day', d.date), 'Day regenerated')}>Regenerate day</Button>
              </div>
            </div>
            <p className="mb-hint mb-num">
              Protein {formatNutrient(d.nutrition.proteinG, 'proteinG')} · Carbohydrate {formatNutrient(d.nutrition.carbsG, 'carbsG')} · Fat {formatNutrient(d.nutrition.fatG, 'fatG')}
            </p>
            {items.length === 0 ? <Notice tone="warn">No meals planned for this day. Regenerate the day to fill it.</Notice> : null}
            {items.map((i) => (
              <PlanMealCard key={i.id} item={i} onPlan={update} onLog={setLogItem} onDetails={setDetailItem} onChoose={setChooseItem} />
            ))}
          </section>
        );
      })}

      <LogPlannedDialog item={logItem} onClose={() => setLogItem(null)} onLogged={() => { setLogItem(null); plan.reload(); }} />
      <MealDetailsDialog item={detailItem ? p.items.find((x) => x.id === detailItem.id) ?? null : null} people={p.preferences.people} onClose={() => setDetailItem(null)} onPlan={update} />
      <ChooseMealDialog item={chooseItem} onClose={() => setChooseItem(null)} onPlan={update} />
      <GroceryDialog open={grocery} planId={p.id} onClose={() => setGrocery(false)} />

      <ConfirmDialog open={confirm === 'regen-week'} title="Regenerate the whole week?" confirmLabel="Regenerate" busy={busy === 'regen'}
        body={<p>All unlocked meals will be replaced using this plan's preferences. Locked meals stay. Meals you've already logged stay in your food log.</p>}
        onClose={() => setConfirm(null)}
        onConfirm={async () => { if (await act('regen', () => api.regenerate(p.id, 'week'), 'Week regenerated')) setConfirm(null); else setConfirm(null); }} />
      <ConfirmDialog open={confirm === 'delete'} title="Delete this plan?" danger confirmLabel="Delete plan" busy={busy === 'delete'}
        body={<p>The plan will be removed. Anything you logged from it stays in your food log.</p>}
        onClose={() => setConfirm(null)}
        onConfirm={async () => { if (await act('delete', () => api.deletePlan(p.id), 'Plan deleted')) { setConfirm(null); onDeleted(); } }} />
      <ConfirmDialog open={confirm === 'overwrite'} title="Replace your saved plan?" confirmLabel="Replace saved plan" busy={busy === 'save'}
        body={<p>You already have a saved plan for the week of {formatLocalDate(p.weekStart, { day: 'numeric', month: 'long' })}. Saving this one will replace it. Logged meals are not affected.</p>}
        onClose={() => setConfirm(null)}
        onConfirm={async () => { await act('save', () => api.savePlan(p.id, true), 'Plan saved'); setConfirm(null); }} />
    </section>
  );
}

function formatAmount(a: { quantity: number; unit: string }) {
  if (a.unit === 'to taste') return 'to taste';
  return `${formatNumber(a.quantity, a.quantity < 10 ? 2 : 0)} ${a.unit}`;
}

function GroceryDialog({ open, planId, onClose }: { open: boolean; planId: string; onClose: () => void }) {
  const { api, toast } = useNutrition();
  const [data, setData] = useState<{ people: number; lines: GroceryLine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setData(null);
    setError(null);
    api.groceryList(planId).then(setData, (e) => setError(errorMessage(e)));
  }, [open, planId, api]);

  const text = data ? data.lines.map((l) => `${l.name}: ${l.amounts.map(formatAmount).join(' + ')}`).join('\n') : '';
  return (
    <Dialog open={open} title="Grocery list" onClose={onClose} footer={<>
      <Button onClick={onClose}>Close</Button>
      <Button variant="primary" disabled={!data} onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast('Grocery list copied');
        } catch {
          toast('Copy not available in this browser');
        }
      }}>Copy list</Button>
    </>}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!data && !error ? <Spinner label="Building list" /> : null}
      {data ? (
        <div className="mb-stack">
          <p className="mb-small mb-muted">For {data.people} {data.people === 1 ? 'person' : 'people'}, all planned meals. Amounts in different kinds of units (for example grams and cups) are listed separately because they can't be combined reliably. No prices are included.</p>
          <table className="mb-table">
            <thead><tr><th>Item</th><th className="mb-num">Amount</th></tr></thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.name}><td>{l.name}</td><td className="mb-num">{l.amounts.map(formatAmount).join(' + ')}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Dialog>
  );
}
