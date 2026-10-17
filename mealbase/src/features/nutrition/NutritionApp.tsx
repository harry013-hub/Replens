/**
 * Mountable root of the nutrition module.
 *
 *   <NutritionApp apiBaseUrl="/api/v1/nutrition" routeBase="/nutrition" />
 *
 * Everything renders inside `.mb-root`, so styles stay scoped.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClientConfig, Me, UserPreferences } from '../../shared/types/api';
import { browserTimeZone } from '../../shared/lib/dates';
import { Button, Field, Notice, Spinner, Toast } from '../../shared/ui';
import { AppShell } from '../../components/AppShell';
import { ApiError, NutritionApiClient } from './api/client';
import { NutritionContext, useLocationState, type AppLink, type NutritionContextValue } from './app-context';
import { errorMessage } from './hooks';
import { TodayPage } from './pages/TodayPage';
import { FoodSearchPage } from './pages/FoodSearchPage';
import { MealPlanPage } from './pages/MealPlanPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';

export interface NutritionAppProps {
  apiBaseUrl?: string;
  routeBase?: string;
  /** Force light or dark; default follows the device. */
  theme?: 'light' | 'dark';
  client?: NutritionApiClient;
  /** Optional app switcher, e.g. [{ label: 'RepLens', href: '../' }, { label: 'MealBase', href: './', current: true }] */
  appLinks?: AppLink[];
}

type Boot =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'signin'; config: ClientConfig; reason: string | null }
  | { state: 'ready'; config: ClientConfig; me: Me; prefs: UserPreferences };

export function NutritionApp({ apiBaseUrl = '/api/v1/nutrition', routeBase = '/', theme, client, appLinks = [] }: NutritionAppProps) {
  const api = useMemo(() => client ?? new NutritionApiClient(apiBaseUrl), [client, apiBaseUrl]);
  const loc = useLocationState(routeBase);
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    let config: ClientConfig;
    try {
      config = await api.config();
    } catch (e) {
      setBoot({ state: 'error', message: errorMessage(e) });
      return;
    }
    try {
      let me = await api.me();
      // Keep the profile timezone in step with this device the first time.
      const tz = browserTimeZone();
      if (me.timezone === 'UTC' && tz !== 'UTC') me = await api.updateMe({ timezone: tz });
      const prefs = await api.preferences();
      api.setProfileId(me.profileId);
      setBoot({ state: 'ready', config, me, prefs });
    } catch (e) {
      if (e instanceof ApiError && e.isAuth) setBoot({ state: 'signin', config, reason: e.code === 'SESSION_EXPIRED' ? e.message : null });
      else setBoot({ state: 'error', message: errorMessage(e) });
    }
  }, [api]);

  useEffect(() => {
    api.onAuthError = (err) => {
      setBoot((b) => (b.state === 'ready' ? { state: 'signin', config: b.config, reason: err.code === 'SESSION_EXPIRED' ? err.message : 'Please sign in again.' } : b));
    };
    void load();
  }, [api, load]);

  const rootProps = { className: 'mb-root', 'data-theme': theme };

  if (boot.state === 'loading') return <div {...rootProps}><div className="mb-main"><Spinner label="Loading MealBase" /></div></div>;
  if (boot.state === 'error') {
    return (
      <div {...rootProps}><div className="mb-main"><div className="mb-page">
        <Notice tone="error" title="MealBase couldn't load">{boot.message}</Notice>
        <div><Button onClick={() => { setBoot({ state: 'loading' }); void load(); }}>Try again</Button></div>
      </div></div></div>
    );
  }
  if (boot.state === 'signin') {
    return <div {...rootProps}><SignIn api={api} reason={boot.reason} onDone={() => { setBoot({ state: 'loading' }); void load(); }} /></div>;
  }

  const ctx: NutritionContextValue = {
    api,
    config: boot.config,
    me: boot.me,
    prefs: boot.prefs,
    setPrefs: (prefs) => setBoot({ ...boot, prefs }),
    routeBase,
    appLinks,
    path: loc.path,
    query: loc.query,
    navigate: loc.navigate,
    toast: setToastMsg,
    signOut: async () => {
      await api.logout().catch(() => undefined);
      setBoot({ state: 'signin', config: boot.config, reason: null });
    },
  };

  const page = (() => {
    switch (loc.path) {
      case '/': return <TodayPage />;
      case '/search': return <FoodSearchPage />;
      case '/plan': return <MealPlanPage />;
      case '/history': return <HistoryPage />;
      case '/settings': return <SettingsPage />;
      default: return (
        <div className="mb-page"><Notice tone="info" title="Page not found">That page doesn't exist. <a href="#" onClick={(e) => { e.preventDefault(); loc.navigate('/'); }}>Go to Today</a>.</Notice></div>
      );
    }
  })();

  return (
    <div {...rootProps}>
      <NutritionContext.Provider value={ctx}>
        <AppShell>{page}</AppShell>
        <Toast message={toastMsg} onDone={() => setToastMsg(null)} />
      </NutritionContext.Provider>
    </div>
  );
}

function SignIn({ api, reason, onDone }: { api: NutritionApiClient; reason: string | null; onDone: () => void }) {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signin') await api.login(email, password);
      else await api.register(email, password, browserTimeZone());
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-main">
      <form className="mb-page mb-panel" style={{ maxWidth: 420 }} onSubmit={submit}>
        <h1>{mode === 'signin' ? 'Sign in to MealBase' : 'Create your MealBase account'}</h1>
        {reason ? <Notice tone="warn">{reason}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Field label="Email">{(id) => <input id={id} className="mb-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Password" hint={mode === 'register' ? 'At least 10 characters.' : undefined}>
          {(id, d) => <input id={id} aria-describedby={d} className="mb-input" type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" busy={busy} block>{mode === 'signin' ? 'Sign in' : 'Create account'}</Button>
        <Button variant="quiet" onClick={() => { setMode(mode === 'signin' ? 'register' : 'signin'); setError(null); }}>
          {mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </Button>
      </form>
    </div>
  );
}
