/**
 * App-wide context: API client, config, profile, preferences and a tiny
 * history-based router that respects a configurable route base.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import type { ClientConfig, Me, UserPreferences } from '../../shared/types/api';
import type { NutritionApiClient } from './api/client';

export interface NutritionContextValue {
  api: NutritionApiClient;
  config: ClientConfig;
  me: Me;
  prefs: UserPreferences;
  setPrefs: (p: UserPreferences) => void;
  routeBase: string;
  /** Links to sibling apps shown as a switcher (e.g. RepLens ↔ MealBase). */
  appLinks: AppLink[];
  path: string;
  query: URLSearchParams;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
  toast: (msg: string) => void;
  signOut: () => Promise<void>;
}

export interface AppLink { label: string; href: string; current?: boolean }

export const NutritionContext = createContext<NutritionContextValue | null>(null);

export function useNutrition(): NutritionContextValue {
  const v = useContext(NutritionContext);
  if (!v) throw new Error('useNutrition must be used inside <NutritionApp>');
  return v;
}

function stripBase(pathname: string, base: string): string {
  if (base === '/' || !base) return pathname || '/';
  return pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname;
}

/** Where a route lives in the URL. `'#'` = hash routing (static hosts without rewrites). */
export function hrefFor(routeBase: string, to: string): string {
  const path = to.startsWith('/') ? to : `/${to}`;
  if (routeBase === '#') return `#${path}`;
  return (routeBase === '/' ? '' : routeBase) + path;
}

function readLocation(routeBase: string) {
  if (routeBase === '#') {
    const raw = window.location.hash.replace(/^#/, '') || '/';
    const i = raw.indexOf('?');
    return { path: (i < 0 ? raw : raw.slice(0, i)) || '/', search: i < 0 ? '' : raw.slice(i) };
  }
  return { path: stripBase(window.location.pathname, routeBase), search: window.location.search };
}

/**
 * Tiny router. `routeBase` lets a host mount MealBase under e.g. /nutrition (History API),
 * or pass '#' for hash routing, which works on any static host without rewrite rules.
 */
export function useLocationState(routeBase: string) {
  const [loc, setLoc] = useState(() => readLocation(routeBase));
  useEffect(() => {
    const on = () => setLoc(readLocation(routeBase));
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); };
  }, [routeBase]);
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    const href = hrefFor(routeBase, to);
    if (opts?.replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
    setLoc(readLocation(routeBase));
    window.scrollTo?.(0, 0);
  }, [routeBase]);
  const query = useMemo(() => new URLSearchParams(loc.search), [loc.search]);
  return { path: loc.path, query, navigate };
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const { navigate, routeBase } = useNutrition();
  return (
    <a
      href={hrefFor(routeBase, to)}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
