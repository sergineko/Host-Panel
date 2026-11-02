import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeftRight,
  Cpu,
  Database,
  Globe,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Moon,
  Package,
  Rocket,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { CommandPalette, type PaletteItem } from './CommandPalette';
import { Spinner, cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  group?: string;
  keywords?: string;
}

const nav: NavItem[] = [
  { to: '/', label: 'Resumen', icon: <LayoutDashboard className="size-4" />, keywords: 'inicio dashboard' },
  { to: '/sites', label: 'Sitios web', icon: <Rocket className="size-4" />, group: 'Hosting', keywords: 'despliegue github webhook' },
  { to: '/domains', label: 'Dominios y DNS', icon: <Globe className="size-4" />, group: 'Hosting', keywords: 'zona registros' },
  { to: '/mail', label: 'Correo', icon: <Mail className="size-4" />, group: 'Hosting', keywords: 'buzones webmail email' },
  { to: '/databases', label: 'Bases de datos', icon: <Database className="size-4" />, group: 'Hosting', keywords: 'mariadb mysql sql d1' },
  { to: '/storage', label: 'Almacenamiento', icon: <Package className="size-4" />, group: 'Hosting', keywords: 'r2 s3 buckets archivos cdn' },
  { to: '/servers', label: 'Servidores', icon: <Server className="size-4" />, group: 'Red y seguridad', keywords: 'vps balanceador nodos' },
  { to: '/proxy', label: 'Proxy inverso', icon: <ArrowLeftRight className="size-4" />, group: 'Red y seguridad', keywords: 'caddy rutas redirecciones' },
  { to: '/security', label: 'Seguridad / WAF', icon: <ShieldCheck className="size-4" />, group: 'Red y seguridad', keywords: 'firewall ip bloqueo ataque' },
  { to: '/analytics', label: 'Analítica', icon: <Activity className="size-4" />, group: 'Red y seguridad', keywords: 'tráfico visitas peticiones' },
  { to: '/system', label: 'Sistema', icon: <Cpu className="size-4" />, group: 'Administración', keywords: 'actualizaciones php versiones' },
  { to: '/settings', label: 'Ajustes', icon: <Settings className="size-4" />, group: 'Administración', keywords: 'contraseña 2fa sesiones' },
];

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  return (
    <button
      className="rounded-md p-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      aria-label="Cambiar tema"
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle('dark', next);
        try {
          localStorage.setItem('hp-theme', next ? 'dark' : 'light');
        } catch {
          /* ignore */
        }
        setDark(next);
      }}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-7 place-items-center rounded-md bg-accent text-accent-fg shadow-[inset_0_-1px_0_rgba(0,0,0,.15)]">
        <svg viewBox="0 0 32 32" className="size-4" fill="currentColor" aria-hidden>
          <path d="M6 6h6v8h8V6h6v20h-6v-7h-8v7H6z" />
        </svg>
      </div>
      <span className="text-[15px] font-semibold tracking-tight">HostPanel</span>
    </div>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Layout({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const qc = useQueryClient();
  const location = useLocation();
  // Version check is cached by the server for an hour; refresh rarely here too.
  const updates = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.get<{ components: { updateAvailable: boolean }[] }>('/api/updates'),
    staleTime: 3600_000,
    refetchInterval: 3600_000,
  });
  const pendingUpdates = updates.data?.components.filter((c) => c.updateAvailable).length ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setOpen(false), [location.pathname]);

  const pages = useMemo<PaletteItem[]>(
    () => nav.map((n) => ({ id: `page-${n.to}`, label: n.label, hint: n.keywords, icon: n.icon, to: n.to, group: 'Páginas' })),
    [],
  );

  let lastGroup: string | undefined;
  const sidebar = (
    <nav className="flex h-full flex-col p-3" aria-label="Principal">
      <div className="mb-3 flex items-center justify-between px-2 pt-1">
        <Logo />
        <button className="rounded p-1 text-muted lg:hidden" onClick={() => setOpen(false)} aria-label="Cerrar menú">
          <X className="size-4" />
        </button>
      </div>
      <button
        onClick={() => setPalette(true)}
        className="mb-2 flex h-8 items-center gap-2 rounded-md border border-border bg-bg px-2.5 text-[13px] text-muted transition-colors hover:border-accent/40 hover:text-fg"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Buscar…</span>
        <kbd className="rounded border border-border bg-surface px-1 font-mono text-[10.5px]">{isMac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      <div className="-mx-1 flex-1 overflow-y-auto px-1">
        {nav.map((item) => {
          const header = item.group && item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.to}>
              {header && <div className="mt-4 mb-1 px-2.5 text-[11px] font-medium tracking-wide text-muted uppercase">{header}</div>}
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cx(
                    'relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 font-medium transition-colors',
                    isActive
                      ? 'bg-surface-2 text-fg before:absolute before:top-1.5 before:bottom-1.5 before:-left-3 before:w-[3px] before:rounded-r before:bg-accent'
                      : 'text-muted hover:bg-surface-2/60 hover:text-fg',
                  )
                }
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
                {item.to === '/system' && pendingUpdates > 0 && (
                  <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg" title="Actualizaciones disponibles">
                    {pendingUpdates}
                  </span>
                )}
              </NavLink>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border pt-3 pl-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-[12px] font-semibold uppercase">{username.slice(0, 1)}</div>
          <div className="min-w-0">
            <div className="truncate font-medium">{username}</div>
            <div className="text-xs text-muted">Administrador</div>
          </div>
        </div>
        <div className="flex">
          <ThemeToggle />
          <button
            className="rounded-md p-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            aria-label="Cerrar sesión"
            onClick={async () => {
              await api.post('/api/auth/logout');
              qc.clear();
              window.location.href = '/login';
            }}
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-surface lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-surface shadow-xl">{sidebar}</aside>
        </div>
      )}
      <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <button onClick={() => setOpen(true)} className="rounded p-1 text-muted" aria-label="Abrir menú">
          <Menu className="size-5" />
        </button>
        <Logo />
        <button onClick={() => setPalette(true)} className="ml-auto rounded p-1.5 text-muted" aria-label="Buscar">
          <Search className="size-4" />
        </button>
      </header>
      <main key={location.pathname.split('/')[1]} className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
        <Suspense fallback={<Spinner className="py-24" />}>
          <Outlet />
        </Suspense>
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} pages={pages} />
    </div>
  );
}
