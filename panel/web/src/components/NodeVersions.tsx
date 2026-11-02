import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Hexagon, RefreshCw, Trash2 } from 'lucide-react';
import { api, type NodeOverview } from '../lib/api';
import { JobLog } from './JobLog';
import { CodeBlock } from './TokensPanel';
import { Badge, Button, Callout, Card, ConfirmButton, Empty, ErrorBox, Spinner, cx } from './ui';

interface Available {
  major: string;
  latest: string;
  lts: string | false;
  date: string;
}

const specLabel = (spec: string) => (spec === 'latest' ? 'la última' : spec === 'system' ? 'la del sistema' : /^\d+$/.test(spec) ? `${spec}.x` : 'fijada');

/** Node.js versions on the server: which sites use each one, install and remove. */
export function NodeVersions() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['nodejs'], queryFn: () => api.get<NodeOverview>('/api/nodejs') });
  const available = useQuery({ queryKey: ['nodejs-available'], queryFn: () => api.get<Available[]>('/api/nodejs/available'), staleTime: 3600_000 });
  const [jobId, setJobId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const start = { onSuccess: (r: { job_id: number }) => (setJobId(r.job_id), setRunning(true)), onError: (e: Error) => toast.error(e.message) };
  const install = useMutation({ mutationFn: (version: string) => api.post<{ job_id: number }>('/api/nodejs/install', { version }), ...start });
  const remove = useMutation({ mutationFn: (version: string) => api.post<{ job_id: number }>('/api/nodejs/remove', { version }), ...start });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const data = q.data!;
  const busy = (!!data.job && jobId === null) || running;
  const activeJob = jobId ?? data.job?.id ?? null;
  const installed = new Set(data.installed.map((n) => n.version));
  const example = available.data?.[0]?.latest ?? '22.11.0';

  return (
    <div className="space-y-4">
      {data.missing.length > 0 && (
        <Callout tone="danger" title="Sitios sin una versión de Node.js válida">
          {data.missing.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ', '}
              <Link to={`/sites/${s.id}`} className="font-medium underline">
                {s.name}
              </Link>{' '}
              (pide {s.spec === 'latest' ? 'la última' : s.spec})
            </span>
          ))}
          . Instala esa versión o cambia la del sitio; mientras tanto no se podrá desplegar.
        </Callout>
      )}

      <Card
        padded={false}
        title="Versiones instaladas"
        description="Cada sitio usa la versión que elige en su configuración. «Siempre la última» toma la más alta de esta lista."
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => api.get('/api/nodejs?refresh=1').then(() => qc.invalidateQueries({ queryKey: ['nodejs'] }))}>
            Volver a buscar
          </Button>
        }
      >
        {data.installed.length === 0 ? (
          <Empty icon={<Hexagon className="size-6" />} title="No hay Node.js instalado" description="Instala una versión abajo o a mano en la carpeta indicada." />
        ) : (
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.installed.map((n) => {
              const latest = n.version === data.latest;
              return (
                <div key={n.version} className={cx('flex flex-col gap-3 rounded-xl border p-4', latest ? 'border-accent/40 bg-accent-soft/40' : 'border-border')}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono text-lg font-semibold tracking-tight">Node.js {n.version}</div>
                      <div className="truncate font-mono text-[11.5px] text-muted" title={n.bin}>
                        {n.bin}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {latest && <Badge tone="accent">Última</Badge>}
                      {n.system && <Badge tone="info">Sistema</Badge>}
                    </div>
                  </div>
                  <div className="text-[13px] text-muted">
                    {n.sites.length === 0 ? (
                      'Ningún sitio la usa'
                    ) : (
                      <>
                        {n.sites.map((s, i) => (
                          <span key={s.id}>
                            {i > 0 && ', '}
                            <Link to={`/sites/${s.id}`} className="font-medium text-fg hover:text-accent">
                              {s.name}
                            </Link>
                            <span className="text-xs"> ({specLabel(s.spec)})</span>
                          </span>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted">
                    <span>{n.source}</span>
                    {n.removable && (
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Eliminar Node.js ${n.version}`}
                        title={`Eliminar Node.js ${n.version}`}
                        message={
                          n.sites.length
                            ? 'Los sitios que la usan por «última» o por versión mayor pasarán a otra versión instalada en su próximo despliegue.'
                            : 'Se borrará la carpeta de esta versión.'
                        }
                        disabled={busy}
                        onConfirm={() => remove.mutateAsync(n.version)}
                      >
                        <Trash2 className="size-3.5" />
                      </ConfirmButton>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {activeJob !== null && (
        <JobLog
          jobId={activeJob}
          onDone={(job) => {
            setRunning(false);
            qc.invalidateQueries({ queryKey: ['nodejs'] });
            if (job.status === 'success') toast.success(job.title + ': completado');
            else toast.error(job.title + ': falló');
          }}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Instalar desde nodejs.org" description="Binarios oficiales, comprobados con su suma SHA-256.">
          {available.isLoading ? (
            <Spinner />
          ) : !available.data?.length ? (
            <p className="text-[13px] text-muted">No se pudo consultar nodejs.org. Instala la versión a mano (a la derecha).</p>
          ) : (
            <ul className="divide-y divide-border">
              {available.data.map((v) => (
                <li key={v.major} className="flex items-center justify-between gap-3 py-2">
                  <span className="flex items-center gap-2">
                    <span className="font-mono font-medium">{v.latest}</span>
                    {v.lts ? <Badge tone="ok">LTS {v.lts}</Badge> : <Badge>Actual</Badge>}
                  </span>
                  {installed.has(v.latest) ? (
                    <Badge tone="ok" dot>
                      Instalada
                    </Badge>
                  ) : (
                    <Button size="sm" icon={<Download className="size-3.5" />} disabled={busy} loading={install.isPending && install.variables === v.latest} onClick={() => install.mutate(v.latest)}>
                      Instalar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">Las versiones no se actualizan solas: instala la nueva y, cuando ningún sitio dependa de la vieja, elimínala.</p>
        </Card>
        <Card title="Instalar a mano" description={<>Cualquier carpeta dentro de <span className="font-mono">{data.dir}</span> con un bin/node se detecta sola.</>}>
          <CodeBlock>{`cd /tmp
curl -fsSLO https://nodejs.org/dist/v${example}/node-v${example}-linux-x64.tar.xz
sudo mkdir -p ${data.dir}/${example}
sudo tar -xJf node-v${example}-linux-x64.tar.xz -C ${data.dir}/${example} --strip-components=1
${data.dir}/${example}/bin/node -v`}</CodeBlock>
          <p className="mt-3 text-xs text-muted">También se detectan las versiones de n, nvm (en /usr/local) y el node del sistema.</p>
        </Card>
      </div>
    </div>
  );
}
