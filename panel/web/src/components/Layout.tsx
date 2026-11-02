import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeftRight,
  Database,
  Globe,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Moon,
  Rocket,
  Settings,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { cx } from './ui';

const nav: { to: string; label: string; icon: ReactNode; group?: string }[] = [
  { to: '/', label: 'Resumen', icon: <LayoutDashboard className="size-4" /> },
  { to: '/sites', label: 'Sitios web', icon: <Rocket className="size-4" />, group: 'Hosting' },
  { to: '/domains', label: 'Dominios y DNS', icon: <Globe className="size-4" />, group: 'Hosting' },
  { to: '/mail', label: 'Correo', icon: <Mail className="size-4" />, group: 'Hosting' },
  { to: '/databases', label: 'Bases de datos', icon: <Database className="size-4" />, group: 'Hosting' },
  { to: '/proxy', label: 'Proxy inverso', icon: <ArrowLeftRight className="size-4" />, group: 'Red' },
  { to: '/security', label: 'Seguridad / WAF', icon: <ShieldCheck className="size-4" />, group: 'Red' },
  { to: '/analytics', label: 'Analítica', icon: <Activity className="size-4" />, group: 'Red' },
  { to: '/settings', label: 'Ajustes', icon: <Settings className="size-4" />, group: 'Sistema' },
];

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  return (
    <button
      className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg"
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
      <div className="grid size-7 place-items-center rounded-md bg-accent text-accent-fg">
        <svg viewBox="0 0 32 32" className="size-4" fill="currentColor">
          <path d="M6 6h6v8h8V6h6v20h-6v-7h-8v7H6z" />
        </svg>
      </div>
      <span className="text-[15px] font-semibold tracking-tight">HostPanel</span>
    </div>
  );
}

export function Layout({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const location = useLocation();
  let lastGroup: string | undefined;

  const sidebar = (
    <nav className="flex h-full flex-col gap-0.5 p-3">
      <div className="mb-4 flex items-center justify-between px-2 pt-1">
        <Logo />
        <button className="rounded p-1 text-muted lg:hidden" onClick={() => setOpen(false)} aria-label="Cerrar menú">
          <X className="size-4" />
        </button>
      </div>
      {nav.map((item) => {
        const header = item.group && item.group !== lastGroup ? item.group : null;
        lastGroup = item.group;
        return (
          <div key={item.to}>
            {header && <div className="mt-4 mb-1 px-2.5 text-[11px] font-medium tracking-wide text-muted uppercase">{header}</div>}
            <NavLink
              to={item.to}
              end={item.to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 font-medium transition-colors',
                  isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg',
                )
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          </div>
        );
      })}
      <div className="mt-auto flex items-center justify-between border-t border-border pt-3 pl-2.5">
        <div className="min-w-0">
          <div className="truncate font-medium">{username}</div>
          <div className="text-xs text-muted">Administrador</div>
        </div>
        <div className="flex">
          <ThemeToggle />
          <button
            className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg"
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
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-surface">{sidebar}</aside>
        </div>
      )}
      <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <button onClick={() => setOpen(true)} className="rounded p-1 text-muted" aria-label="Abrir menú">
          <Menu className="size-5" />
        </button>
        <Logo />
      </header>
      <main key={location.pathname.split('/')[1]} className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
