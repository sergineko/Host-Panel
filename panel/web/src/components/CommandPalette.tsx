import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, Database, Globe, Inbox, Package, Rocket, Search, Zap } from 'lucide-react';
import { api, type Bucket, type DatabaseInfo, type Domain, type Queue, type Site, type Worker } from '../lib/api';
import { cx } from './ui';

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  to: string;
  group: string;
}

/** Ctrl/⌘ + K: jump to any page, site, domain, bucket or database. */
export function CommandPalette({ open, onClose, pages }: { open: boolean; onClose: () => void; pages: PaletteItem[] }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/api/sites'), enabled: open, staleTime: 30_000 });
  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.get<Domain[]>('/api/domains'), enabled: open, staleTime: 30_000 });
  const buckets = useQuery({ queryKey: ['buckets'], queryFn: () => api.get<Bucket[]>('/api/buckets'), enabled: open, staleTime: 30_000 });
  const dbs = useQuery({ queryKey: ['databases'], queryFn: () => api.get<DatabaseInfo[]>('/api/databases'), enabled: open, staleTime: 30_000 });
  const workers = useQuery({ queryKey: ['workers'], queryFn: () => api.get<Worker[]>('/api/workers'), enabled: open, staleTime: 30_000 });
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api.get<Queue[]>('/api/queues'), enabled: open, staleTime: 30_000 });

  const items = useMemo<PaletteItem[]>(
    () => [
      ...pages,
      ...(workers.data ?? []).map((w) => ({ id: `wk-${w.id}`, label: w.name, hint: w.url?.replace('https://', '') ?? 'Worker', icon: <Zap className="size-4" />, to: `/workers/${w.id}`, group: 'Workers' })),
      ...(queues.data ?? []).map((q) => ({ id: `q-${q.id}`, label: q.name, hint: `${q.backlog.total} pendientes`, icon: <Inbox className="size-4" />, to: `/queues/${q.id}`, group: 'Colas' })),
      ...(sites.data ?? []).map((s) => ({ id: `site-${s.id}`, label: s.name, hint: s.hostnames[0], icon: <Rocket className="size-4" />, to: `/sites/${s.id}`, group: 'Sitios' })),
      ...(domains.data ?? []).map((d) => ({ id: `dom-${d.id}`, label: d.name, hint: 'DNS, correo y seguridad', icon: <Globe className="size-4" />, to: `/domains/${d.id}`, group: 'Dominios' })),
      ...(buckets.data ?? []).map((b) => ({ id: `bk-${b.id}`, label: b.name, hint: b.hostname || 'bucket', icon: <Package className="size-4" />, to: `/storage/${b.id}`, group: 'Almacenamiento' })),
      ...(dbs.data ?? []).map((d) => ({ id: `db-${d.id}`, label: d.name, hint: 'MariaDB', icon: <Database className="size-4" />, to: `/databases/${d.id}`, group: 'Bases de datos' })),
    ],
    [pages, sites.data, domains.data, buckets.data, dbs.data, workers.data, queues.data],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 40);
    return items
      .map((it) => {
        const text = `${it.label} ${it.hint ?? ''} ${it.group}`.toLowerCase();
        const idx = text.indexOf(q);
        return { it, score: idx === -1 ? -1 : (it.label.toLowerCase().startsWith(q) ? 0 : 1) + idx / 100 };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 40)
      .map((x) => x.it);
  }, [items, query]);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      setActive(0);
      d.showModal();
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    navigate(it.to);
  };

  let lastGroup = '';
  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => e.target === dialogRef.current && onClose()}
      className="mx-auto mt-[12vh] w-[calc(100%-32px)] max-w-xl rounded-xl border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-[2px]"
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search className="size-4 text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(filtered.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              go(filtered[active]);
            }
          }}
          placeholder="Buscar páginas, sitios, dominios, buckets…"
          className="h-12 flex-1 bg-transparent outline-none placeholder:text-muted focus-visible:outline-none"
        />
        <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted">Esc</kbd>
      </div>
      <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
        {filtered.length === 0 && <p className="px-3 py-8 text-center text-[13px] text-muted">Sin resultados para “{query}”.</p>}
        {filtered.map((it, i) => {
          const header = it.group !== lastGroup ? it.group : null;
          lastGroup = it.group;
          return (
            <div key={it.id}>
              {header && <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">{header}</div>}
              <button
                data-index={i}
                onMouseMove={() => setActive(i)}
                onClick={() => go(it)}
                className={cx('flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left', i === active ? 'bg-surface-2' : '')}
              >
                <span className={cx(i === active ? 'text-accent' : 'text-muted')}>{it.icon}</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{it.label}</span>
                  {it.hint && <span className="ml-2 text-[13px] text-muted">{it.hint}</span>}
                </span>
                {i === active && <CornerDownLeft className="size-3.5 text-muted" />}
              </button>
            </div>
          );
        })}
      </div>
    </dialog>
  );
}
