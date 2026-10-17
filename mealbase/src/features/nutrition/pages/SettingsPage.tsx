import { useRef, useState } from 'react';
import type { UserPreferences } from '../../../shared/types/api';
import { addDays, browserTimeZone, isValidTimeZone } from '../../../shared/lib/dates';
import { Button, ConfirmDialog, Field, Notice } from '../../../shared/ui';
import { useNutrition } from '../app-context';
import { errorMessage, todayLocal } from '../hooks';
import { PlanPreferencesForm } from '../components/PlanPreferencesForm';

export function SettingsPage() {
  const { api, prefs, setPrefs, me, config, toast, signOut } = useNutrition();
  const [draft, setDraft] = useState<UserPreferences>(prefs);
  const [targetText, setTargetText] = useState(prefs.dailyCalorieTarget ? String(prefs.dailyCalorieTarget) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = targetText.trim() === '' ? null : Math.round(Number(targetText));
  const targetInvalid = target !== null && (!Number.isFinite(target) || target < 1000 || target > 6000);
  const tzInvalid = !isValidTimeZone(draft.timezone);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const planner = { ...draft.planner, mode: draft.adultConfirmed ? draft.planner.mode : 'general' as const };
      const next = await api.savePreferences({ dailyCalorieTarget: target, adultConfirmed: draft.adultConfirmed, timezone: draft.timezone, planner });
      setPrefs(next);
      setDraft(next);
      toast('Settings saved');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-page">
      <h1>Settings</h1>

      <section className="mb-panel mb-stack" aria-labelledby="mb-target">
        <h2 id="mb-target">Daily calorie target</h2>
        <p className="mb-small">Optional. If you have a target — for example one from a dietitian or doctor — MealBase shows it next to what you've logged. It never tells you to eat less or exercise more to make up a difference.</p>
        <Field label="Target (kcal per day)" hint="Leave empty for no target. Accepted range 1,000–6,000 to catch typos; this is not a recommendation." error={targetInvalid ? 'Enter a number between 1,000 and 6,000, or leave it empty.' : null}>
          {(id, d) => <input id={id} aria-describedby={d} className="mb-input" style={{ maxWidth: 220 }} type="number" inputMode="numeric" min={1000} max={6000} step={50}
            value={targetText} onChange={(e) => setTargetText(e.target.value)} aria-invalid={targetInvalid} />}
        </Field>
        <label className="mb-check">
          <input type="checkbox" checked={draft.adultConfirmed} onChange={(e) => setDraft({ ...draft, adultConfirmed: e.target.checked })} />
          <span>I am 18 or older<br /><span className="mb-hint">Needed to plan meals around a calorie target. MealBase doesn't create calorie-deficit plans for anyone under 18.</span></span>
        </label>
      </section>

      <section className="mb-panel mb-stack" aria-labelledby="mb-tz">
        <h2 id="mb-tz">Timezone</h2>
        <p className="mb-small mb-muted">Used to decide which day a meal belongs to and what “next week” means.</p>
        <div className="mb-row" style={{ alignItems: 'end' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Field label="Timezone" error={tzInvalid ? 'Unknown timezone name.' : null}>
              {(id) => <input id={id} className="mb-input" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} list="mb-tz-list" />}
            </Field>
            <datalist id="mb-tz-list">
              {(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []).map((z) => <option key={z} value={z} />)}
            </datalist>
          </div>
          <Button onClick={() => setDraft({ ...draft, timezone: browserTimeZone() })}>Use this device's timezone</Button>
        </div>
      </section>

      <section className="mb-panel mb-stack-lg" aria-labelledby="mb-planner-defaults">
        <h2 id="mb-planner-defaults">Meal-plan preferences</h2>
        <PlanPreferencesForm value={draft.planner} adultConfirmed={draft.adultConfirmed} onChange={(planner) => setDraft({ ...draft, planner })} />
      </section>

      {error ? <Notice tone="error">{error}</Notice> : null}
      <div><Button variant="primary" busy={busy} disabled={targetInvalid || tzInvalid} onClick={save}>Save settings</Button></div>

      <section className="mb-panel mb-stack" aria-labelledby="mb-connections">
        <h2 id="mb-connections">Connections</h2>
        <dl className="mb-stack mb-small">
          <div>
            <dt><strong>Food database</strong></dt>
            <dd>{config.foodProvider.mode === 'direct'
              ? (config.foodProvider.deviceKeySet ? 'USDA FoodData Central, using your own key saved on this device.' : 'USDA FoodData Central, using the shared demo key (about 30 searches an hour).')
              : config.foodProvider.configured
                ? `USDA FoodData Central connected${config.foodProvider.usingDemoKey ? ' with the shared DEMO_KEY (very low limits — set your own key)' : ''}.`
                : 'Not connected. The server needs a USDA_API_KEY. Manual entry works without it.'}</dd>
          </div>
          <div>
            <dt><strong>{config.workout.label}</strong></dt>
            <dd>{config.workout.configured ? `Connected: ${config.workout.url}` : 'Workout connection not configured (server setting WORKOUT_APP_URL).'}</dd>
          </div>
          {config.sampleFoodsEnabled ? (
            <div><dt><strong>Sample data</strong></dt><dd>Development sample foods are shown in search, clearly labelled. Turn off with SAMPLE_FOODS_ENABLED=false.</dd></div>
          ) : null}
        </dl>
      </section>

      {config.foodProvider.mode === 'direct' ? <DeviceKeySection /> : null}

      <DataSection />

      <section className="mb-panel mb-stack" aria-labelledby="mb-account">
        <h2 id="mb-account">Account</h2>
        {config.persistence === 'device' || config.persistence === 'memory' ? (
          <Notice tone="info">Your food log is stored only in this browser on this device{config.persistence === 'memory' ? ' — and right now this browser can’t save it, so it disappears when you close the page' : ''}. It isn't uploaded or shared. Clearing this site's data in the browser removes it; use the exports above to keep a copy or move it to another device.</Notice>
        ) : me.authMode === 'local' ? (
          <Notice tone="info">Single-user local mode. Anyone using this MealBase server shares this one food log. Use account mode for a shared or public deployment.</Notice>
        ) : (
          <div className="mb-row-between">
            <span>Signed in as <strong>{me.email}</strong></span>
            <Button onClick={() => void signOut()}>Sign out</Button>
          </div>
        )}
      </section>

      <p className="mb-footnote">
        Nutrition values are estimates based on food database records and the portions you choose. MealBase is a logging and planning tool and does not provide individual medical nutrition advice.
        Food data: {config.foodProvider.attribution}
      </p>
    </div>
  );
}

function DataSection() {
  const { api, me, toast } = useNutrition();
  const today = todayLocal(me.timezone);
  const [from, setFrom] = useState(addDays(today, -89));
  const [to, setTo] = useState(today);
  const [confirm, setConfirm] = useState<null | 'history' | 'all'>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function importFile(file: File) {
    setMsg(null);
    try {
      const data = JSON.parse(await file.text());
      const r = await api.importPlans(data, true);
      setMsg({ tone: 'success', text: `Imported ${r.plans} plan${r.plans === 1 ? '' : 's'} as drafts${r.preferences ? ' and your preferences' : ''}.` });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof SyntaxError ? 'That file is not valid JSON.' : errorMessage(e) });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <section className="mb-panel mb-stack" aria-labelledby="mb-data">
      <h2 id="mb-data">Your data</h2>
      {msg ? <div className={`mb-notice mb-notice-${msg.tone}`} role="status">{msg.text}</div> : null}
      <h3>Export food log (CSV)</h3>
      <div className="mb-grid-2">
        <Field label="From">{(id) => <input id={id} className="mb-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(id) => <input id={id} className="mb-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <div><Button onClick={() => api.downloadLogsCsv(from, to).catch((e) => setMsg({ tone: 'error', text: errorMessage(e) }))}>Download CSV</Button></div>
      <h3>Meal plans and preferences (JSON)</h3>
      <div className="mb-row">
        <Button onClick={() => api.downloadPlansJson().catch((e) => setMsg({ tone: 'error', text: errorMessage(e) }))}>Download JSON</Button>
        <Button onClick={() => fileRef.current?.click()}>Import JSON…</Button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />
      </div>
      <p className="mb-hint">Imported plans are added as drafts and never overwrite saved plans. Age confirmation is not imported.</p>
      <h3>Delete</h3>
      <div className="mb-row">
        <Button variant="danger" onClick={() => { setTyped(''); setConfirm('history'); }}>Delete food log history</Button>
        <Button variant="danger" onClick={() => { setTyped(''); setConfirm('all'); }}>Delete all my nutrition data</Button>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        danger
        busy={busy}
        confirmDisabled={typed !== 'DELETE'}
        title={confirm === 'all' ? 'Delete all nutrition data?' : 'Delete food log history?'}
        confirmLabel={confirm === 'all' ? 'Delete everything' : 'Delete history'}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (typed !== 'DELETE') return;
          setBusy(true);
          try {
            if (confirm === 'all') {
              await api.deleteAllData();
              toast('All nutrition data deleted');
              window.location.reload();
            } else {
              const r = await api.deleteHistory();
              toast(`Deleted ${r.deletedEntries} entries`);
            }
            setConfirm(null);
          } catch (e) {
            setMsg({ tone: 'error', text: errorMessage(e) });
            setConfirm(null);
          } finally {
            setBusy(false);
          }
        }}
        body={<>
          <p>{confirm === 'all'
            ? 'This permanently removes your food log, meal plans, preferences, your own foods and your recipes.'
            : 'This permanently removes every food log entry. Meal plans and recipes are kept.'} It can't be undone. Export first if you want a copy.</p>
          <Field label='Type DELETE to confirm'>{(id) => <input id={id} className="mb-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
        </>}
      />
    </section>
  );
}

function DeviceKeySection() {
  const { api, config, setConfig, toast } = useNutrition();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      setConfig(await api.setDeviceUsdaKey(value));
      setKey('');
      toast(value ? 'USDA key saved on this device' : 'USDA key removed');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-panel mb-stack" aria-labelledby="mb-usda-key">
      <h2 id="mb-usda-key">USDA food search key</h2>
      <p className="mb-small">
        Food search works right away with USDA's shared demo key, which allows about 30 searches an hour. For more, get a free key at{' '}
        <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noreferrer">fdc.nal.usda.gov/api-key-signup</a> and paste it here.
      </p>
      <p className="mb-hint">The key is saved only in this browser on this device and sent only to USDA. It isn't part of the website or your exports. Anyone using this browser could see it.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Your USDA key">{(id) => <input id={id} className="mb-input" autoComplete="off" spellCheck={false} placeholder={config.foodProvider.deviceKeySet ? 'A key is saved' : 'Paste your key'} value={key} onChange={(e) => setKey(e.target.value)} />}</Field>
      <div className="mb-row">
        <Button variant="primary" busy={busy} disabled={!key.trim()} onClick={() => save(key.trim())}>Save key</Button>
        {config.foodProvider.deviceKeySet ? <Button busy={busy} onClick={() => save(null)}>Remove key</Button> : null}
      </div>
    </section>
  );
}
