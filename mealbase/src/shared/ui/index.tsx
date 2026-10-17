/**
 * Small, unopinionated UI primitives. Styling lives in tokens.css / components.css.
 */
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { NutrientKey, NutrientTotals, NutrientValues } from '../types/nutrition';
import { formatNutrient, missingNote, NUTRIENT_LABELS } from '../lib/nutrition';

type ButtonVariant = 'default' | 'primary' | 'quiet' | 'danger';

export function Button({
  variant = 'default', size, block, busy, children, className = '', ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm'; block?: boolean; busy?: boolean }) {
  const cls = [
    'mb-btn',
    variant === 'primary' && 'mb-btn-primary',
    variant === 'quiet' && 'mb-btn-quiet',
    variant === 'danger' && 'mb-btn-danger',
    size === 'sm' && 'mb-btn-sm',
    block && 'mb-btn-block',
    className,
  ].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={rest.disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="mb-spinner" aria-hidden="true" style={{ width: 16, height: 16, borderWidth: 2 }} /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="mb-field">
      <label htmlFor={id} className="mb-label">{label}</label>
      {children(id, describedBy)}
      {hint ? <span id={hintId} className="mb-hint">{hint}</span> : null}
      {error ? <span id={errId} className="mb-hint" style={{ color: 'var(--mb-error-ink)' }} role="alert">{error}</span> : null}
    </div>
  );
}

export function Notice({ tone = 'info', children, title }: { tone?: 'info' | 'warn' | 'error' | 'success'; children?: ReactNode; title?: string }) {
  return (
    <div className={`mb-notice mb-notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="mb-row" role="status">
      <span className="mb-spinner" aria-hidden="true" />
      <span className="mb-muted mb-small">{label}…</span>
    </div>
  );
}

export function Dialog({ open, title, onClose, children, footer }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="mb-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open ? (
        <div className="mb-dialog-inner">
          <div className="mb-dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="mb-btn mb-btn-quiet mb-icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </div>
          {children}
          {footer ? <div className="mb-dialog-foot">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel, danger, busy, confirmDisabled, onConfirm, onClose }: {
  open: boolean; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; confirmDisabled?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dialog open={open} title={title} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant={danger ? 'danger' : 'primary'} busy={busy} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button>
    </>}>
      <div className="mb-stack">{body}</div>
    </Dialog>
  );
}

export function Toast({ message, onDone }: { message: ReactNode | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return <div className="mb-toast" role="status" aria-live="polite">{message}</div>;
}

/** Shows calories and macros; unavailable values are labelled, never shown as 0. */
export function NutrientList({ values, totals, compact }: { values: NutrientValues | NutrientTotals; totals?: boolean; compact?: boolean }) {
  const keys: NutrientKey[] = compact ? ['proteinG', 'carbsG', 'fatG'] : ['calories', 'proteinG', 'carbsG', 'fatG'];
  return (
    <dl className="mb-macros">
      {keys.map((k) => {
        const note = totals ? missingNote(values as NutrientTotals, k) : null;
        return (
          <div key={k}>
            <dt>{NUTRIENT_LABELS[k]}</dt>
            <dd>{formatNutrient(values[k], k)}</dd>
            {note ? <span className="mb-hint">{note}</span> : null}
          </div>
        );
      })}
    </dl>
  );
}

const ICONS: Record<string, ReactNode> = {
  today: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  plan: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  history: <><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4h4M12 8v4l3 2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>,
  trash: <><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  left: <path d="m15 5-7 7 7 7" />,
  right: <path d="m9 5 7 7-7 7" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  unlock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></>,
  swap: <><path d="M7 7h11l-3-3M17 17H6l3 3" /></>,
  check: <path d="m5 12 5 5 9-10" />,
  dumbbell: <><path d="M6 8v8M18 8v8M3 10v4M21 10v4M6 12h12" /></>,
};

export function Icon({ name, label }: { name: keyof typeof ICONS | string; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      {ICONS[name]}
    </svg>
  );
}
