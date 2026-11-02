import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link } from 'react-router';
import { AlertTriangle, Check, CheckCircle2, ChevronRight, Copy, Info, Loader2, OctagonAlert, X } from 'lucide-react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

// --- Button --------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 border-transparent shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.15)]',
  secondary: 'bg-surface text-fg border-border shadow-card hover:bg-surface-2 hover:border-border-strong',
  danger: 'bg-surface text-danger border-border hover:bg-danger-soft hover:border-danger/40',
  ghost: 'bg-transparent text-muted border-transparent hover:bg-surface-2 hover:text-fg',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-1.5 border font-medium whitespace-nowrap transition-[background,filter,color,border-color,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-7 rounded-md px-2.5 text-[13px]' : 'h-9 rounded-lg px-3.5',
        variants[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// --- Form controls -------------------------------------------------------------------
const control =
  'w-full rounded-lg border border-border bg-surface px-3 text-fg shadow-card placeholder:text-muted/70 transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 disabled:opacity-60';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(control, 'h-9', className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(control, 'min-h-20 py-2 font-mono text-[13px]', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(control, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block space-y-1.5', className)}>
      <span className="text-[13px] font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-start justify-between gap-4 py-3', disabled && 'cursor-not-allowed opacity-60')}>
      <span>
        <span className="block font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] text-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-200', checked ? 'bg-accent' : 'bg-border-strong')}
      >
        <span className={cx('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-200', checked && 'translate-x-4')} />
      </button>
    </label>
  );
}

/** Card-style choice (radio or checkbox look) used for types, policies and versions. */
export function ChoiceCard({
  selected,
  onClick,
  icon,
  title,
  description,
  badge,
  multi,
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  multi?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cx(
        'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-[border-color,background,box-shadow] disabled:cursor-not-allowed disabled:opacity-50',
        selected ? 'border-accent bg-accent-soft/60 ring-3 ring-accent/10' : 'border-border bg-surface shadow-card hover:border-border-strong',
      )}
    >
      <span
        className={cx(
          'mt-0.5 grid size-4 shrink-0 place-items-center border transition-colors',
          multi ? 'rounded' : 'rounded-full',
          selected ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong',
        )}
      >
        {selected && (multi ? <Check className="size-3" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-current" />)}
      </span>
      {icon && <span className={cx('shrink-0 [&>svg]:size-5', selected ? 'text-accent' : 'text-muted')}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{title}</span>
          {badge}
        </span>
        {description && <span className="mt-0.5 block text-[12.5px] text-muted">{description}</span>}
      </span>
    </button>
  );
}

// --- Layout pieces -------------------------------------------------------------------
export function Card({
  title,
  description,
  icon,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cx('rounded-xl border border-border bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {icon && <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted [&>svg]:size-4">{icon}</span>}
            <div className="min-w-0">
              <h2 className="font-semibold">{title}</h2>
              {description && <p className="text-[12.5px] text-muted">{description}</p>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

/** The navigation section the current page belongs to (provided by the layout). */
export interface Section {
  to: string;
  label: string;
  group?: string;
  icon: ReactNode;
  /** Classes for the tinted icon tile. */
  tone: string;
  /** True on a detail page under the section (e.g. /sites/12). */
  nested: boolean;
}
export const SectionContext = createContext<Section | null>(null);

export function PageHeader({
  title,
  description,
  actions,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Defaults to the icon of the current section. */
  icon?: ReactNode;
}) {
  const section = useContext(SectionContext);
  const shownIcon = icon ?? section?.icon;
  return (
    <div className="mb-6">
      {section && section.to !== '/' && (
        <nav aria-label="Ruta" className="mb-3 flex items-center gap-1 text-[12.5px] text-muted">
          {section.group && <span>{section.group}</span>}
          {section.group && <ChevronRight className="size-3.5 opacity-60" />}
          {section.nested ? (
            <Link to={section.to} className="font-medium text-fg/75 hover:text-accent">
              {section.label}
            </Link>
          ) : (
            <span className="font-medium text-fg/75">{section.label}</span>
          )}
        </nav>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {shownIcon && (
            <div className={cx('grid size-11 shrink-0 place-items-center rounded-xl [&>svg]:size-5', section?.tone ?? 'bg-accent-soft text-accent')}>{shownIcon}</div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-[22px] leading-tight font-semibold tracking-tight">{title}</h1>
            {description && <div className="mt-0.5 text-[13.5px] text-muted">{description}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Highlighted message inside a page (information, warning, error or success). */
export function Callout({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const styles = {
    info: 'border-info/25 bg-info-soft [&_.ic]:text-info',
    warn: 'border-warn/30 bg-warn-soft [&_.ic]:text-warn',
    danger: 'border-danger/30 bg-danger-soft [&_.ic]:text-danger',
    ok: 'border-ok/30 bg-ok-soft [&_.ic]:text-ok',
  }[tone];
  const Icon = tone === 'danger' ? OctagonAlert : tone === 'warn' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Info;
  return (
    <div className={cx('flex flex-wrap items-start gap-3 rounded-xl border px-3.5 py-3 text-[13px]', styles, className)}>
      <Icon className="ic mt-px size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx(title ? 'mt-0.5' : '', 'text-fg/80')}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Metric tile: label, big value, optional detail and link. */
export function StatCard({
  label,
  value,
  sub,
  icon,
  to,
  tone = 'bg-surface-2 text-muted',
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  to?: string;
  tone?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] text-muted">{label}</span>
        {icon && <span className={cx('grid size-7 shrink-0 place-items-center rounded-lg [&>svg]:size-4', tone)}>{icon}</span>}
      </div>
      <div className="mt-2 flex min-w-0 items-baseline gap-2">
        <span className="tabular text-2xl font-semibold tracking-tight">{value}</span>
        {sub && <span className="truncate text-xs text-muted">{sub}</span>}
      </div>
    </>
  );
  const cls = 'block min-w-0 rounded-xl border border-border bg-surface p-4 shadow-card';
  return to ? (
    <Link to={to} className={cx(cls, 'transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-accent/40')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'violet';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent',
  violet: 'bg-violet-soft text-violet',
};

export function Badge({ tone = 'neutral', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone])}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const statusMap: Record<string, { tone: Tone; label: string }> = {
  live: { tone: 'ok', label: 'En línea' },
  success: { tone: 'ok', label: 'Correcto' },
  deploying: { tone: 'info', label: 'Desplegando' },
  running: { tone: 'info', label: 'En curso' },
  queued: { tone: 'neutral', label: 'En cola' },
  new: { tone: 'neutral', label: 'Nuevo' },
  failed: { tone: 'danger', label: 'Fallido' },
};

export function StatusBadge({ status }: { status: string }) {
  const s = statusMap[status] ?? { tone: 'neutral' as Tone, label: status };
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

export function Empty({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-4 grid size-12 place-items-center rounded-2xl border border-border bg-surface-2 text-muted shadow-card">{icon}</div>}
      <p className="font-semibold">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div className={cx('flex justify-center py-10 text-muted', className)}>
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
      <OctagonAlert className="mt-px size-4 shrink-0" />
      <span className="min-w-0">{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

// --- Table ---------------------------------------------------------------------------
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-border bg-surface-2/50 text-[11.5px] tracking-wide text-muted uppercase">
            {head.map((h, i) => (
              <th key={i} className="px-4 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-surface-2/40">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cx('px-4 py-2.5 align-middle', className)}>{children}</td>
);

// --- Modal ---------------------------------------------------------------------------
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // React's autoFocus runs before the dialog opens, so focus the first field here.
      d.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea, select')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cx(
        'm-auto w-[calc(100%-32px)] rounded-2xl border border-border bg-surface p-0 text-fg shadow-pop backdrop:bg-black/50 backdrop:backdrop-blur-[2px]',
        wide ? 'max-w-3xl' : 'max-w-lg',
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Cerrar">
              <X className="size-4" />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex justify-end gap-2 rounded-b-2xl border-t border-border bg-surface-2/40 px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmButton({
  onConfirm,
  title,
  message,
  label = 'Eliminar',
  children,
  ...rest
}: { onConfirm: () => Promise<unknown> | void; title: string; message: ReactNode; label?: string } & Omit<Parameters<typeof Button>[0], 'onClick'>) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button {...rest} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancelar</Button>
            <Button
              variant="primary"
              className="!bg-danger !text-white"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {label}
            </Button>
          </>
        }
      >
        <div className="text-muted">{message}</div>
      </Modal>
    </>
  );
}

/** Save bar that stays visible at the bottom of long forms without covering content. */
export function StickyActions({ children }: { children: ReactNode }) {
  return <div className="sticky bottom-0 z-10 -mx-1 flex justify-end gap-2 border-t border-border bg-bg/85 px-1 py-3 backdrop-blur-md">{children}</div>;
}

// --- Copyable value ------------------------------------------------------------------
export function Copyable({ value, secret, className }: { value: string; secret?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  return (
    <div className={cx('flex min-w-0 items-center gap-1 rounded-lg border border-border bg-surface-2 py-1 pr-1 pl-2.5', className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" onClick={() => setShown(true)}>
        {shown ? value : '•'.repeat(Math.min(value.length, 24))}
      </code>
      <button
        type="button"
        className="rounded p-1 text-muted hover:bg-surface hover:text-fg"
        aria-label="Copiar"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border [scrollbar-width:none]">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 font-medium whitespace-nowrap transition-colors [&>svg]:size-4',
            value === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:border-border-strong hover:text-fg',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
