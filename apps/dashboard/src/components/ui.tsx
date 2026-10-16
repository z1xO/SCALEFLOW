'use client';

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 border border-transparent',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2',
  danger: 'bg-surface text-critical-ink border border-line hover:bg-surface-2',
  ghost: 'bg-transparent text-ink-2 border border-transparent hover:bg-surface-2',
};

export function Button({
  variant = 'secondary',
  busy = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  );
}

const fieldClass =
  'w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-muted disabled:opacity-60';

export function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; id?: string }) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children(fieldId)}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p className="text-xs text-critical-ink" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...rest },
  ref,
) {
  return <input ref={ref} {...rest} className={`${fieldClass} ${className}`} />;
});

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`${fieldClass} ${className}`}>
      {children}
    </select>
  );
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={`${fieldClass} font-mono ${className}`} />;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Spinner({ small = false, label = 'Loading' }: { small?: boolean; label?: string }) {
  const size = small ? 'h-3.5 w-3.5' : 'h-5 w-5';
  return (
    <span role="status" aria-label={label} className={`inline-block ${size} animate-spin rounded-full border-2 border-current border-t-transparent opacity-70`} />
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-surface-2 ${className}`} />;
}

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={title}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button variant="ghost" aria-label="Close dialog" onClick={onClose}>
          ✕
        </Button>
      </div>
      <div className="p-4">{children}</div>
    </dialog>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'success'; children: ReactNode }) {
  const styles = {
    info: 'border-line bg-surface-2 text-ink-2',
    error: 'border-critical/40 bg-critical/10 text-critical-ink',
    success: 'border-good/40 bg-good/10 text-good-ink',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${styles}`}>
      {children}
    </div>
  );
}

export function CodeBlock({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink">
      {text ?? 'null'}
    </pre>
  );
}
