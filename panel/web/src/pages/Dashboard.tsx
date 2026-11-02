import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowUpCircle, Boxes, Database, Globe, Mail, Network, Package, Rocket, Server, ShieldAlert, Zap } from 'lucide-react';
import { api, type TrafficPoint } from '../lib/api';
import { bytes, compact, duration, timeAgo } from '../lib/format';
import { Badge, Callout, Card, Empty, ErrorBox, PageHeader, Spinner, StatCard, StatusBadge } from '../components/ui';
import { TrafficChart } from '../components/TrafficChart';
import { certHasProblem, useCertificates } from '../components/Certificates';

interface DashboardData {
  system: { hostname: string; uptime: number; load: number[]; cpus: number; memory: { total: number; free: number }; disk: { total: number; free: number }; serverIp: string };
  services: { name: string; active: boolean; state: string }[];
  caddy: { lastError: string; lastSync: number };
  counts: {
    domains: number;
    sites: number;
    proxies: number;
    databases: number;
    nosql: number;
    loadBalancers: number;
    workers: number;
    mailDomains: number;
    buckets: number;
    servers: number;
    serversOnline: number;
  };
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

export default function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/api/dashboard'), refetchInterval: 15000 });
  const updates = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.get<{ components: { name: string; updateAvailable: boolean }[] }>('/api/updates'),
    staleTime: 3600_000,
  });
  const pending = updates.data?.components.filter((c) => c.updateAvailable) ?? [];
  const certs = useCertificates();
  const badCerts = certs.data?.certificates.filter(certHasProblem) ?? [];
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
      <div className="mb-5 space-y-2.5 empty:hidden">
        {d.panel.dev && <Callout tone="warn">Modo desarrollo: los cambios no se aplican al sistema.</Callout>}
        {down.length > 0 && (
          <Callout tone="danger" title={`Servicios detenidos: ${down.map((s) => s.name).join(', ')}`}>
            Revisa el estado con <code className="font-mono">sudo hostpanel status</code>.
          </Callout>
        )}
        {d.caddy.lastError && (
          <Callout tone="danger" title="El proxy rechazó la última configuración">
            <span className="font-mono text-xs break-all">{d.caddy.lastError.slice(0, 300)}</span>
          </Callout>
        )}
        {badCerts.length > 0 && (
          <Callout
            tone="danger"
            title={`${badCerts.length} certificado${badCerts.length === 1 ? '' : 's'} SSL con problemas`}
            action={
              <Link to="/certificates" className="font-medium text-danger hover:underline">
                Revisar
              </Link>
            }
          >
            {badCerts.slice(0, 4).map((c) => c.host).join(', ')}
            {badCerts.length > 4 ? '…' : ''}
          </Callout>
        )}
        {pending.length > 0 && (
          <Callout
            tone="info"
            title="Actualizaciones disponibles"
            action={
              <Link to="/system" className="inline-flex items-center gap-1 font-medium text-info hover:underline">
                <ArrowUpCircle className="size-4" /> Ver
              </Link>
            }
          >
            {pending.map((c) => c.name).join(', ')}
          </Callout>
        )}
      </div>

      <h2 className="mb-2.5 text-[12px] font-semibold tracking-wide text-muted uppercase">Recursos</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard to="/sites" icon={<Rocket />} tone="bg-accent-soft text-accent" label="Sitios web" value={d.counts.sites} />
        <StatCard to="/domains" icon={<Globe />} tone="bg-accent-soft text-accent" label="Dominios" value={d.counts.domains} />
        <StatCard to="/mail" icon={<Mail />} tone="bg-accent-soft text-accent" label="Dominios con correo" value={d.counts.mailDomains} />
        <StatCard to="/databases" icon={<Database />} tone="bg-info-soft text-info" label="Bases de datos SQL" value={d.counts.databases} />
        <StatCard to="/nosql" icon={<Boxes />} tone="bg-info-soft text-info" label="Bases de datos NoSQL" value={d.counts.nosql} />
        <StatCard to="/storage" icon={<Package />} tone="bg-info-soft text-info" label="Almacenamiento" value={d.counts.buckets} sub="buckets" />
        <StatCard to="/workers" icon={<Zap />} tone="bg-violet-soft text-violet" label="Workers" value={d.counts.workers} />
        <StatCard to="/load-balancers" icon={<Network />} tone="bg-ok-soft text-ok" label="Balanceadores" value={d.counts.loadBalancers} />
        <StatCard
          to="/servers"
          icon={<Server />}
          tone="bg-ok-soft text-ok"
          label="Servidores"
          value={d.counts.servers + 1}
          sub={d.counts.servers ? `${d.counts.serversOnline + 1} en línea` : 'solo este'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title="Tráfico · últimas 24 h"
          actions={
            <>
              <Badge>{compact(d.traffic24h.requests)} peticiones</Badge>
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
