import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowLeftRight, Database, Globe, Mail, Rocket, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { api, type TrafficPoint } from '../lib/api';
import { bytes, compact, duration, timeAgo } from '../lib/format';
import { Badge, Card, Empty, ErrorBox, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { TrafficChart } from '../components/TrafficChart';

interface DashboardData {
  system: { hostname: string; uptime: number; load: number[]; cpus: number; memory: { total: number; free: number }; disk: { total: number; free: number }; serverIp: string };
  services: { name: string; active: boolean; state: string }[];
  caddy: { lastError: string; lastSync: number };
  counts: { domains: number; sites: number; proxies: number; databases: number; mailDomains: number };
  traffic24h: { requests: number; bytes: number; blocked: number };
  series: TrafficPoint[];
  recentDeployments: { id: number; site_id: number; site_name: string; status: string; trigger: string; commit_message: string; created_at: string }[];
  panel: { domain: string; ip: string; port: number; dev: boolean };
}

function Meter({ label, used, total, detail }: { label: string; used: number; total: number; detail: string }) {
  const pct = total ? Math.round((used / total) * 100) : 0;
  const tone = pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-ok';
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted">{detail}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${tone} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ to, icon, label, value }: { to: string; icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <Link to={to} className="group rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/50">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        {icon}
        {label}
      </div>
      <div className="tabular mt-2 text-2xl font-semibold">{value}</div>
    </Link>
  );
}

export default function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/api/dashboard'), refetchInterval: 15000 });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const memUsed = d.system.memory.total - d.system.memory.free;
  const diskUsed = d.system.disk.total - d.system.disk.free;
  const down = d.services.filter((s) => !s.active);

  return (
    <>
      <PageHeader
        title="Resumen"
        description={
          <>
            {d.system.hostname} · {d.system.serverIp} · encendido {duration(d.system.uptime)}
          </>
        }
      />
      {d.panel.dev && (
        <div className="mb-4 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">
          Modo desarrollo: los cambios no se aplican al sistema.
        </div>
      )}
      {down.length > 0 && (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          Servicios detenidos: {down.map((s) => s.name).join(', ')}. Ejecuta <code className="font-mono">sudo hostpanel status</code>.
        </div>
      )}
      {d.caddy.lastError && (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          El proxy rechazó la última configuración: {d.caddy.lastError.slice(0, 300)}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat to="/sites" icon={<Rocket className="size-4" />} label="Sitios" value={d.counts.sites} />
        <Stat to="/domains" icon={<Globe className="size-4" />} label="Dominios" value={d.counts.domains} />
        <Stat to="/mail" icon={<Mail className="size-4" />} label="Dominios con correo" value={d.counts.mailDomains} />
        <Stat to="/databases" icon={<Database className="size-4" />} label="Bases de datos" value={d.counts.databases} />
        <Stat to="/proxy" icon={<ArrowLeftRight className="size-4" />} label="Rutas de proxy" value={d.counts.proxies} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Tráfico · últimas 24 h"
          actions={
            <>
              <Badge>{bytes(d.traffic24h.bytes)}</Badge>
              <Badge tone={d.traffic24h.blocked ? 'danger' : 'neutral'}>
                <ShieldAlert className="size-3" />
                {compact(d.traffic24h.blocked)} bloqueadas
              </Badge>
            </>
          }
        >
          <TrafficChart series={d.series} />
        </Card>

        <Card title="Servidor">
          <div className="space-y-4">
            <Meter label="CPU" used={Math.min(d.system.load[0] ?? 0, d.system.cpus)} total={d.system.cpus} detail={`carga ${(d.system.load[0] ?? 0).toFixed(2)} · ${d.system.cpus} núcleos`} />
            <Meter label="Memoria" used={memUsed} total={d.system.memory.total} detail={`${bytes(memUsed)} / ${bytes(d.system.memory.total)}`} />
            <Meter label="Disco" used={diskUsed} total={d.system.disk.total} detail={`${bytes(diskUsed)} / ${bytes(d.system.disk.total)}`} />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border pt-4">
            {d.services.map((s) => (
              <div key={s.name} className="flex items-center gap-2 text-[13px]">
                <span className={`size-1.5 rounded-full ${s.active ? 'bg-ok' : 'bg-danger'}`} />
                <span className="truncate">{s.name}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="lg:col-span-3" title="Últimos despliegues" padded={false}>
          {d.recentDeployments.length === 0 ? (
            <Empty icon={<Rocket className="size-6" />} title="Aún no hay despliegues" description="Crea un sitio y conecta tu repositorio de GitHub." />
          ) : (
            <ul className="divide-y divide-border">
              {d.recentDeployments.map((dep) => (
                <li key={dep.id}>
                  <Link to={`/sites/${dep.site_id}?deployment=${dep.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/50">
                    <StatusBadge status={dep.status} />
                    <span className="font-medium">{dep.site_name}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">{dep.commit_message || dep.trigger}</span>
                    <span className="text-xs whitespace-nowrap text-muted">{timeAgo(dep.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
