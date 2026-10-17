import type { ReactNode } from 'react';
import { Icon } from '../shared/ui';
import { Link, useNutrition } from '../features/nutrition/app-context';

const NAV = [
  { to: '/', label: 'Today', icon: 'today' },
  { to: '/search', label: 'Food Search', icon: 'search' },
  { to: '/plan', label: 'Meal Plan', icon: 'plan' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { path, appLinks } = useNutrition();
  const active = (to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(to + '/'));
  return (
    <div className="mb-shell">
      <nav className="mb-nav" aria-label="MealBase">
        <Link to="/" className="mb-brand">MealBase</Link>
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} aria-current={active(n.to) ? 'page' : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
      <main className="mb-main" id="mb-main">
        {appLinks.length ? <AppSwitcher links={appLinks} /> : null}
        {children}
      </main>
    </div>
  );
}

/** Switch between sibling apps (separate pages), e.g. RepLens ↔ MealBase. */
export function AppSwitcher({ links }: { links: Array<{ label: string; href: string; current?: boolean }> }) {
  return (
    <nav className="mb-switcher" aria-label="Apps">
      {links.map((l) => (
        <a key={l.label} href={l.href} aria-current={l.current ? 'page' : undefined}>{l.label}</a>
      ))}
    </nav>
  );
}
