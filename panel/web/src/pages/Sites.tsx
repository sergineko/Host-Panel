import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, GitBranch, Plus, Rocket } from 'lucide-react';
import { api, type Site } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Spinner, StatusBadge } from '../components/ui';

const typeLabel = { static: 'Estático', php: 'PHP', node: 'Node.js' };

export default function Sites() {
  const q = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/api/sites'), refetchInterval: 10000 });

  return (
    <>
      <PageHeader
        title="Sitios web"
        description="WordPress en un clic o despliegue continuo desde GitHub con versiones y vuelta atrás."
        actions={
          <Link to="/sites/new">
            <Button variant="primary" icon={<Plus className="size-4" />}>
              Nuevo sitio
            </Button>
          </Link>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : q.data!.length === 0 ? (
        <Card>
          <Empty
            icon={<Rocket className="size-6" />}
            title="Todavía no hay sitios"
            description="Instala WordPress en un clic o conecta un repositorio con tu web estática, PHP o Node.js."
            action={
              <Link to="/sites/new">
                <Button variant="primary">Crear el primer sitio</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {q.data!.map((s) => (
            <Link key={s.id} to={`/sites/${s.id}`} className="group rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/50">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold group-hover:text-accent">{s.name}</div>
                  <div className="mt-0.5 flex items-center gap-1 truncate text-[13px] text-muted">
                    {s.hostnames[0]}
                    {s.hostnames.length > 1 && <span>+{s.hostnames.length - 1}</span>}
                    <ExternalLink className="size-3" />
                  </div>
                </div>
                <StatusBadge status={s.status} />
              </div>
              <div className="mt-4 flex items-center gap-2 text-[13px] text-muted">
                <Badge tone={s.source === 'wordpress' ? 'info' : 'neutral'}>{s.source === 'wordpress' ? 'WordPress' : typeLabel[s.type]}</Badge>
                {s.repo_url && (
                  <span className="flex min-w-0 items-center gap-1">
                    <GitBranch className="size-3.5 shrink-0" />
                    <span className="truncate">{s.branch}</span>
                  </span>
                )}
                {s.last_deployment && (
                  <span className="ml-auto min-w-0 truncate text-xs">
                    {s.last_deployment.commit_sha && <code className="mr-1.5 font-mono">{s.last_deployment.commit_sha.slice(0, 7)}</code>}
                    {timeAgo(s.last_deployment.created_at)}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
