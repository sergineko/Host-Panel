import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeftRight,
  ArrowUpCircle,
  Boxes,
  ChevronDown,
  Cpu,
  Database,
  Globe,
  Inbox,
  KeySquare,
  Lock,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Moon,
  Network,
  Package,
  Rocket,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import { CommandPalette, type PaletteItem } from './CommandPalette';
import { SectionContext, Spinner, cx, type Section } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  group?: string;
  keywords?: string;
}

/** Tinted icon tile per group (page headers). */
const groupTone: Record<string, string> = {
  Sitios: 'bg-accent-soft text-accent',
  Datos: 'bg-info-soft text-info',
  Aplicaciones: 'bg-violet-soft text-violet',
  Red: 'bg-ok-soft text-ok',
  Administración: 'bg-surface-2 text-muted',
};

// Ordered by how often each section is used: publish → store data → run code → network → admin.
export const nav: NavItem[] = [
  { to: '/', label: 'Resumen', icon: <LayoutDashboard />, keywords: 'inicio dashboard estado' },
  { to: '/sites', label: 'Sitios web', icon: <Rocket />, group: 'Sitios', keywords: 'despliegue github webhook wordpress node php' },
  { to: '/domains', label: 'Dominios y DNS', icon: <Globe />, group: 'Sitios', keywords: 'zona registros dns' },
  { to: '/mail', label: 'Correo', icon: <Mail />, group: 'Sitios', keywords: 'buzones webmail email' },
  { to: '/databases', label: 'Bases de datos SQL', icon: <Database />, group: 'Datos', keywords: 'mariadb mysql sql tablas' },
  { to: '/nosql', label: 'Bases de datos NoSQL', icon: <Boxes />, group: 'Datos', keywords: 'documentos json colecciones nosql mongodb' },
  { to: '/storage', label: 'Almacenamiento', icon: <Package />, group: 'Datos', keywords: 's3 buckets archivos objetos cdn' },
  { to: '/kv', label: 'Clave-valor (KV)', icon: <KeySquare />, group: 'Datos', keywords: 'kv clave valor cache sesiones' },
  { to: '/workers', label: 'Workers', icon: <Zap />, group: 'Aplicaciones', keywords: 'funciones serverless edge javascript cron' },
  { to: '/queues', label: 'Colas', icon: <Inbox />, group: 'Aplicaciones', keywords: 'queues mensajes segundo plano' },
  { to: '/load-balancers', label: 'Balanceadores de carga', icon: <Network />, group: 'Red', keywords: 'load balancer balanceo origenes alta disponibilidad' },
  { to: '/certificates', label: 'Certificados SSL', icon: <Lock />, group: 'Red', keywords: 'ssl https tls lets encrypt certificado renovación' },
  { to: '/proxy', label: 'Proxy inverso', icon: <ArrowLeftRight />, group: 'Red', keywords: 'caddy rutas redirecciones' },
  { to: '/security', label: 'Seguridad y WAF', icon: <ShieldCheck />, group: 'Red', keywords: 'firewall ip bloqueo ataque waf' },
  { to: '/servers', label: 'Servidores', icon: <Server />, group: 'Red', keywords: 'vps nodos' },
  { to: '/analytics', label: 'Analítica', icon: <Activity />, group: 'Administración', keywords: 'tráfico visitas peticiones' },
  { to: '/system', label: 'Sistema', icon: <Cpu />, group: 'Administración', keywords: 'actualizaciones php node versiones' },
  { to: '/settings', label: 'Ajustes', icon: <Settings />, group: 'Administración', keywords: 'contraseña 2fa sesiones' },
];

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  return (
    <button
      className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      aria-label={dark ? 'Usar tema claro' : 'Usar tema oscuro'}
      title={dark ? 'Tema claro' : 'Tema oscuro'}
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
      <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-[#d4520a] text-white shadow-[inset_0_-1px_0_rgba(0,0,0,.18),0_1px_2px_rgba(0,0,0,.15)]">
        <svg viewBox="0 0 32 32" className="size-4" fill="currentColor" aria-hidden>
          <path d="M6 6h6v8h8V6h6v20h-6v-7h-8v7H6z" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight">HostPanel</div>
      </div>
    </div>
  );
}

const COLLAPSED_KEY = 'hp-nav-collapsed';

/** Menu groups the user folded, remembered in this browser. */
function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* private mode: keep it for this visit only */
      }
      return next;
    });
  return { collapsed, toggle };
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Navigation entry for a path: the longest matching prefix. */
function sectionFor(pathname: string): Section | null {
  let best: NavItem | undefined;
  for (const n of nav) {
    const match = n.to === '/' ? pathname === '/' : pathname === n.to || pathname.startsWith(`${n.to}/`);
    if (match && (!best || n.to.length > best.to.length)) best = n;
  }
  if (!best) return null;
  return {
    to: best.to,
    label: best.label,
    group: best.group,
    icon: best.icon,
    tone: groupTone[best.group ?? ''] ?? 'bg-accent-soft text-accent',
    nested: pathname !== best.to,
  };
}

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
    () => nav.map((n) => ({ id: `page-${n.to}`, label: n.label, hint: n.keywords, icon: <span className="[&>svg]:size-4">{n.icon}</span>, to: n.to, group: 'Páginas' })),
    [],
  );
  const section = useMemo(() => sectionFor(location.pathname), [location.pathname]);
  const { collapsed, toggle } = useCollapsedGroups();

  const groups = useMemo(() => {
    const out: { name?: string; items: NavItem[] }[] = [];
    for (const item of nav) {
      const last = out.at(-1);
      if (last && last.name === item.group) last.items.push(item);
      else out.push({ name: item.group, items: [item] });
    }
    return out;
  }, []);

  const logout = async () => {
    await api.post('/api/auth/logout');
    qc.clear();
    window.location.href = '/login';
  };

  const sidebar = (
    <nav className="flex h-full flex-col" aria-label="Principal">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Link to="/" aria-label="Ir al resumen">
          <Logo />
        </Link>
        <button className="rounded-md p-1 text-muted lg:hidden" onClick={() => setOpen(false)} aria-label="Cerrar menú">
          <X className="size-4" />
        </button>
      </div>
      <div className="px-3 pb-2 lg:hidden">
        <button
          onClick={() => setPalette(true)}
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-[13px] text-muted"
        >
          <Search className="size-3.5" />
          Buscar…
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-3 pt-1 pb-4">
        {groups.map((g) => {
          const folded = !!g.name && collapsed.has(g.name);
          // A folded group still shows the page you are on, so you never lose your place.
          const items = folded ? g.items.filter((i) => i.to === section?.to) : g.items;
          return (
            <div key={g.name ?? 'top'}>
              {g.name && (
                <button
                  type="button"
                  onClick={() => toggle(g.name!)}
                  aria-expanded={!folded}
                  className="group/h mb-1 flex w-full items-center gap-1 rounded-md px-2.5 py-0.5 text-[11px] font-semibold tracking-wider text-muted/80 uppercase transition-colors hover:text-fg"
                >
                  <span className="flex-1 text-left">{g.name}</span>
                  {folded && pendingUpdates > 0 && g.items.some((i) => i.to === '/system') && (
                    <span className="size-1.5 rounded-full bg-accent" title="Actualizaciones disponibles" />
                  )}                  <ChevronDown className={cx('size-3.5 transition-transform duration-200 motion-reduce:transition-none', folded && '-rotate-90')} />
                </button>
              )}
              <div className="space-y-px">
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      cx(
                        'group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] font-medium transition-colors [&_svg]:size-4',
                        isActive ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={cx('transition-colors', isActive ? 'text-accent' : 'text-muted/80 group-hover:text-fg')}>{item.icon}</span>
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.to === '/system' && pendingUpdates > 0 && (
                          <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg" title="Actualizaciones disponibles">
                            {pendingUpdates}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border p-3">
        <div className="flex min-w-0 items-center gap-2.5 pl-1">
          <div className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-surface-2 to-border text-[12px] font-semibold uppercase">{username.slice(0, 1)}</div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{username}</div>
            <div className="text-xs text-muted">Administrador</div>
          </div>
        </div>
        <button
          className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-danger-soft hover:text-danger"
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
          onClick={logout}
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-surface lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-surface shadow-pop">{sidebar}</aside>
        </div>
      )}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/85 px-4 backdrop-blur-md sm:px-6">
        <button onClick={() => setOpen(true)} className="rounded-md p-1 text-muted lg:hidden" aria-label="Abrir menú">
          <Menu className="size-5" />
        </button>
        <div className="lg:hidden">
          <Logo />
        </div>
        <button
          onClick={() => setPalette(true)}
          className="ml-auto hidden h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-muted transition-colors hover:border-border-strong hover:text-fg sm:flex lg:ml-0"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Buscar sitios, dominios, bases de datos…</span>
          <kbd className="rounded border border-border bg-surface px-1.5 font-mono text-[10.5px]">{isMac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setPalette(true)} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 sm:hidden" aria-label="Buscar">
            <Search className="size-4" />
          </button>
          {pendingUpdates > 0 && (
            <Link
              to="/system"
              className="hidden h-8 items-center gap-1.5 rounded-lg bg-accent-soft px-2.5 text-[12.5px] font-medium text-accent transition-colors hover:brightness-95 sm:flex"
            >
              <ArrowUpCircle className="size-4" />
              {pendingUpdates} actualizaci{pendingUpdates === 1 ? 'ón' : 'ones'}
            </Link>
          )}
          <ThemeToggle />
        </div>
      </header>
      <SectionContext.Provider value={section}>
        <main key={location.pathname.split('/')[1]} className="hp-page mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
          <Suspense fallback={<Spinner className="py-24" />}>
            <Outlet />
          </Suspense>
        </main>
      </SectionContext.Provider>
      <CommandPalette open={palette} onClose={() => setPalette(false)} pages={pages} />
    </div>
  );
}
