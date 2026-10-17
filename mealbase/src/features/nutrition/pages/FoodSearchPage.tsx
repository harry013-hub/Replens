import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FoodSearchResponse, FoodSearchResult } from '../../../shared/types/api';
import { MEAL_TYPES, type Food, type MealType } from '../../../shared/types/nutrition';
import { formatNutrient, formatNumber } from '../../../shared/lib/nutrition';
import { isLocalDate } from '../../../shared/lib/dates';
import { Button, Field, Notice, Spinner } from '../../../shared/ui';
import { useNutrition } from '../app-context';
import { errorMessage, MEAL_LABELS, mealForNow, todayLocal } from '../hooks';
import { ApiError } from '../api/client';
import { FoodDetail } from '../components/FoodDetail';
import { SOURCE_BADGE } from '../source-labels';
import { ManualFoodForm } from '../components/ManualFoodForm';

type View = { kind: 'search' } | { kind: 'detail'; ref: string } | { kind: 'manual' };

export function FoodSearchPage() {
  const { api, me, query, config, navigate } = useNutrition();
  const qMeal = query.get('meal') as MealType | null;
  const qDate = query.get('date');
  const [meal, setMeal] = useState<MealType>(qMeal && MEAL_TYPES.includes(qMeal) ? qMeal : mealForNow());
  const [date, setDate] = useState<string>(qDate && isLocalDate(qDate) ? qDate : todayLocal(me.timezone));
  const [view, setView] = useState<View>({ kind: 'search' });

  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState<FoodSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [recent, setRecent] = useState<Food[] | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    api.recentFoods().then(setRecent, () => setRecent([]));
  }, [api]);

  async function runSearch(q: string, page = 1) {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.searchFoods(q, page);
      if (mine !== seq.current) return;
      setResult((prev) => (page > 1 && prev ? { ...r, results: [...prev.results, ...r.results], mine: prev.mine, sample: prev.sample } : r));
      setSubmitted(q);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL_ERROR', errorMessage(e)));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (q.length < 2) {
      setError(new ApiError(400, 'VALIDATION_ERROR', 'Type at least 2 characters to search.'));
      return;
    }
    void runSearch(q);
  }

  const afterAdd = (name: string) => {
    setView({ kind: 'search' });
    api.recentFoods().then(setRecent, () => undefined);
    return name;
  };

  const target = (
    <div className="mb-panel mb-grid-2" aria-label="Where to add">
      <Field label="Add to">{(id) => (
        <select id={id} className="mb-select" value={meal} onChange={(e) => setMeal(e.target.value as MealType)}>
          {MEAL_TYPES.map((m) => <option key={m} value={m}>{MEAL_LABELS[m]}</option>)}
        </select>
      )}</Field>
      <Field label="Date">{(id) => <input id={id} className="mb-input" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />}</Field>
    </div>
  );

  if (view.kind === 'detail') {
    return (
      <div className="mb-page">
        <div><Button variant="quiet" onClick={() => setView({ kind: 'search' })}>‹ Back to results</Button></div>
        {target}
        <FoodDetail foodRef={view.ref} mealType={meal} date={date} onAdded={(name) => afterAdd(name)} onViewDay={() => navigate(`/?date=${date}`)} />
      </div>
    );
  }
  if (view.kind === 'manual') {
    return (
      <div className="mb-page">
        <div><Button variant="quiet" onClick={() => setView({ kind: 'search' })}>‹ Back to search</Button></div>
        <h1>Add a food manually</h1>
        {target}
        <ManualFoodForm mealType={meal} date={date} initialName={submitted || text} onDone={(name) => afterAdd(name)} />
      </div>
    );
  }

  const p = result?.provider;
  const nothing = result && !result.results.length && !result.mine.length && !result.sample.length;

  return (
    <div className="mb-page">
      <div className="mb-page-head">
        <h1>Food Search</h1>
        <Button onClick={() => setView({ kind: 'manual' })}>Add manually</Button>
      </div>
      {target}

      <form role="search" className="mb-row" onSubmit={onSubmit} style={{ flexWrap: 'nowrap' }}>
        <label htmlFor="mb-food-q" className="mb-sr-only">Food name</label>
        <input id="mb-food-q" className="mb-input" type="search" placeholder="Search foods, e.g. banana" value={text}
          onChange={(e) => setText(e.target.value)} autoComplete="off" enterKeyHint="search" />
        <Button type="submit" variant="primary" busy={loading}>Search</Button>
      </form>

      {!config.foodProvider.configured ? (
        <Notice tone="info" title="Food database search isn't connected">
          This MealBase site has no food database connected, so only your own foods{config.sampleFoodsEnabled ? ' and the bundled generic foods' : ''} can be searched. You can always add a food manually.
        </Notice>
      ) : null}

      {config.foodProvider.id === 'off' ? (
        <p className="mb-hint">
          Searches Open Food Facts, a free community database that's strongest for packaged and branded foods.
          For plain foods like fruit or raw meat, the generic foods list below or Add manually often works better.
        </p>
      ) : null}

      {error ? (
        <Notice tone="error">
          {error.message}
          {submitted || text.trim().length >= 2 ? <div><Button size="sm" onClick={() => runSearch(submitted || text.trim())}>Retry</Button></div> : null}
        </Notice>
      ) : null}

      {loading && !result ? <Spinner label="Searching" /> : null}

      {p && p.status !== 'ok' && p.status !== 'not_configured' ? (
        <Notice tone="warn" title={p.status === 'rate_limited' ? 'Search limit reached' : 'Food database unavailable'}>
          {p.message}
          <div className="mb-row">
            <Button size="sm" onClick={() => runSearch(submitted)}>Retry</Button>
            <Button size="sm" onClick={() => setView({ kind: 'manual' })}>Add manually</Button>
          </div>
        </Notice>
      ) : null}

      {nothing && !loading ? (
        <div className="mb-panel mb-empty">
          <p>No foods match “{submitted}”.</p>
          <Button variant="primary" onClick={() => setView({ kind: 'manual' })}>Add “{submitted}” manually</Button>
        </div>
      ) : null}

      {result?.results.length ? (
        <ResultGroup title={result.provider.label ?? config.foodProvider.label ?? 'Food database'} items={result.results} onPick={(ref) => setView({ kind: 'detail', ref })}
          footer={<>
            {result.totalPages && result.page < result.totalPages ? (
              <Button busy={loading} onClick={() => runSearch(submitted, result.page + 1)}>Show more results</Button>
            ) : null}
            <p className="mb-footnote">Source: {result.provider.attribution}</p>
          </>} />
      ) : null}
      {result?.mine.length ? <ResultGroup title="Your foods" items={result.mine} onPick={(ref) => setView({ kind: 'detail', ref })} /> : null}
      {result?.sample.length ? (
        <ResultGroup
          title="Generic foods (sample data)"
          note="Approximate values for common ingredients, bundled with MealBase. Not from a live database."
          sample
          items={result.sample}
          onPick={(ref) => setView({ kind: 'detail', ref })}
        />
      ) : null}

      {!result && !loading && recent && recent.length ? (
        <section className="mb-panel mb-stack" aria-labelledby="mb-recent">
          <h2 id="mb-recent">Recently logged</h2>
          <div className="mb-list">
            {recent.map((f) => (
              <button key={f.id} type="button" className="mb-list-item" onClick={() => setView({ kind: 'detail', ref: f.id })}>
                <span><strong>{f.name}</strong>{f.brand ? <span className="mb-muted"> · {f.brand}</span> : null}</span>
                {f.isSample ? <span className="mb-badge mb-badge-sample">Sample</span> : <span className="mb-badge">{SOURCE_BADGE[f.source]}</span>}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ResultGroup({ title, items, onPick, note, sample, footer }: {
  title: string; items: FoodSearchResult[]; onPick: (ref: string) => void; note?: string; sample?: boolean; footer?: React.ReactNode;
}) {
  return (
    <section className="mb-panel mb-stack" aria-label={title}>
      <div className="mb-section-title">
        <h2>{title}</h2>
        {sample ? <span className="mb-badge mb-badge-sample">Sample data</span> : null}
      </div>
      {note ? <p className="mb-hint">{note}</p> : null}
      <div className="mb-list">
        {items.map((r) => (
          <button key={r.ref} type="button" className="mb-list-item" onClick={() => onPick(r.ref)}>
            <span>
              <strong>{r.name}</strong>
              {r.brand ? <span className="mb-muted"> · {r.brand}</span> : null}
              <span className="mb-hint" style={{ display: 'block' }}>{r.sourceLabel}</span>
            </span>
            <span className="mb-small mb-muted mb-num" style={{ textAlign: 'right' }}>
              {r.preview ? <>{formatNutrient(r.preview.values.calories, 'calories')}<br />per {formatNumber(r.preview.quantity)} {r.preview.unit}</> : 'Details'}
            </span>
          </button>
        ))}
      </div>
      {footer}
    </section>
  );
}
