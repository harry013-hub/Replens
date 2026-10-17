import { useState } from 'react';
import { addDays, formatLocalDate, isLocalDate } from '../../../shared/lib/dates';
import { formatNutrient } from '../../../shared/lib/nutrition';
import { Button, Field, Notice, Spinner } from '../../../shared/ui';
import { Link, useNutrition } from '../app-context';
import { errorMessage, todayLocal, useAsync } from '../hooks';

export function HistoryPage() {
  const { api, me, toast } = useNutrition();
  const today = todayLocal(me.timezone);
  const [to, setTo] = useState(today);
  const [from, setFrom] = useState(addDays(today, -13));
  const valid = isLocalDate(from) && isLocalDate(to) && from <= to;
  const days = useAsync(() => (valid ? api.history(from, to) : Promise.resolve([])), [from, to]);

  const preset = (n: number) => { setTo(today); setFrom(addDays(today, -(n - 1))); };

  return (
    <div className="mb-page">
      <div className="mb-page-head">
        <h1>History</h1>
        {valid ? <Button onClick={() => api.downloadLogsCsv(from, to).catch((e) => toast(errorMessage(e)))}>Export CSV</Button> : null}
      </div>
      <div className="mb-panel mb-stack">
        <div className="mb-segmented">
          <button type="button" className="mb-btn mb-btn-sm" onClick={() => preset(7)}>Last 7 days</button>
          <button type="button" className="mb-btn mb-btn-sm" onClick={() => preset(14)}>Last 14 days</button>
          <button type="button" className="mb-btn mb-btn-sm" onClick={() => preset(30)}>Last 30 days</button>
        </div>
        <div className="mb-grid-2">
          <Field label="From">{(id) => <input id={id} className="mb-input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="To">{(id) => <input id={id} className="mb-input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        {!valid ? <Notice tone="warn">Choose a start date on or before the end date.</Notice> : null}
      </div>

      {days.loading ? <Spinner label="Loading history" /> : null}
      {days.error ? <Notice tone="error">{days.error.message} <Button size="sm" onClick={days.reload}>Retry</Button></Notice> : null}
      {days.data && !days.loading ? (
        days.data.length ? (
          <section className="mb-panel" aria-label="Logged days">
            <div className="mb-list">
              {days.data.map((d) => (
                <Link key={d.localDate} to={d.localDate === today ? '/' : `/?date=${d.localDate}`} className="mb-list-item">
                  <span>
                    <strong>{formatLocalDate(d.localDate, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
                    <span className="mb-hint" style={{ display: 'block' }}>
                      {d.entryCount} {d.entryCount === 1 ? 'entry' : 'entries'}
                      {d.missingCalories ? ` · ${d.missingCalories} without calorie data` : ''}
                    </span>
                  </span>
                  <span className="mb-num">{formatNutrient(d.nutrition.calories, 'calories')}</span>
                </Link>
              ))}
            </div>
          </section>
        ) : (
          <div className="mb-panel mb-empty">
            <p>No food logged in this period.</p>
            <Link to="/search" className="mb-btn">Log a food</Link>
          </div>
        )
      ) : null}
      <p className="mb-footnote">Days with no entries are hidden. Totals are estimates from the foods and portions you logged.</p>
    </div>
  );
}
