import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Database, Globe, Mail, Rocket } from 'lucide-react';
import { api, type DatabaseInfo, type Domain, type Site } from '../lib/api';
import { useMe } from '../lib/me';
import { Badge, Card, Empty, PageHeader, Spinner } from '../components/ui';

/** Home of a reseller's client: only what belongs to their account. */
export default function ClientHome() {
  const me = useMe();
  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.get<Domain[]>('/api/domains') });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/api/sites') });
  const dbs = useQuery({ queryKey: ['databases'], queryFn: () => api.get<DatabaseInfo[]>('/api/databases') });
  const tiles = [
    { to: '/domains', label: 'Dominios', icon: <Globe />, value: domains.data?.length },
    { to: '/sites', label: 'Sitios web', icon: <Rocket />, value: sites.data?.length },
    { to: '/mail', label: 'Correo', icon: <Mail />, value: domains.data?.filter((d) => d.mail_enabled).length, hint: 'dominios con correo' },
    { to: '/databases', label: 'Bases de datos', icon: <Database />, value: dbs.data?.length },
  ];

  return (
    <>
      <PageHeader title={me.data?.client ? `Hola, ${me.data.client.name}` : 'Resumen'} description="Tus dominios, webs, correo y bases de datos." icon={<Globe />} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.to} to={t.to} className="rounded-xl border border-border bg-surface p-4 shadow-card transition-colors hover:border-border-strong">
            <div className="flex items-center gap-2 text-[13px] text-muted [&>svg]:size-4">
              {t.icon}
              {t.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{t.value ?? '—'}</div>
            {t.hint && <div className="text-xs text-muted">{t.hint}</div>}
          </Link>
        ))}
      </div>
      <Card title="Tus dominios" padded={false}>
        {domains.isLoading ? (
          <Spinner />
        ) : !domains.data?.length ? (
          <Empty icon={<Globe />} title="Aún no tienes dominios" description="Tu proveedor te los asignará desde su panel." />
        ) : (
          <ul className="divide-y divide-border">
            {domains.data.map((d) => (
              <li key={d.id}>
                <Link to={`/domains/${d.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <Globe className="size-4 text-muted" />
                  <span className="flex-1 font-mono text-[13px]">{d.name}</span>
                  {!!d.mail_enabled && <Badge>Correo</Badge>}
                  <span className="text-xs text-muted">{d.sites ?? 0} sitios</span>
                  <ChevronRight className="size-4 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
