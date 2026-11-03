import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowUpCircle, CheckCircle2, Download, RefreshCw, ShieldAlert, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { api, type Job } from '../lib/api';
import { timeAgo } from '../lib/format';
import { JobLog } from '../components/JobLog';
import { NodeVersions } from '../components/NodeVersions';
import { Badge, Button, Callout, Card, ConfirmButton, ErrorBox, PageHeader, Select, Spinner, StatusBadge, Table, Tabs, Td, cx } from '../components/ui';

interface PhpState {
  default: string;
  versions: {
    version: string;
    installed: boolean;
    sites: number;
    /** PHP2Shell status of the installed build. */
    security: { version: string; patched: boolean; via: 'version' | 'backport' | null } | null;
    fixed_in: string | null;
  }[];
  php2shell: { cves: string[] };
  job: Job | null;
}
interface Component {
  id: string;
  name: string;
  description: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
}
interface UpdatesState {
  components: Component[];
  checked_at: string | null;
  auto: 'off' | 'system' | 'all';
  job: Job | null;
}

function PhpVersions() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['php'], queryFn: () => api.get<PhpState>('/api/php') });
  const [jobId, setJobId] = useState<number | null>(null);
  const [jobRunning, setJobRunning] = useState(false);
  const install = useMutation({
    mutationFn: (version: string) => api.post<{ job_id: number }>('/api/php/install', { version }),
    onSuccess: (r) => {
      setJobId(r.job_id);
      setJobRunning(true);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (version: string) => api.post<{ job_id: number }>('/api/php/remove', { version }),
    onSuccess: (r) => {
      setJobId(r.job_id);
      setJobRunning(true);
    },
    onError: (e) => toast.error(e.message),
  });
  const upgrade = useMutation({
    mutationFn: (version: string) => api.post<{ job_id: number }>('/api/php/upgrade', { version }),
    onSuccess: (r) => {
      setJobId(r.job_id);
      setJobRunning(true);
    },
    onError: (e) => toast.error(e.message),
  });
  const setDefault = useMutation({
    mutationFn: (version: string) => api.put('/api/php/default', { version }),
    onSuccess: () => {
      toast.success('Versión por defecto actualizada');
      qc.invalidateQueries({ queryKey: ['php'] });
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const busy = (!!q.data!.job && jobId === null) || jobRunning || install.isPending;
  const activeJob = jobId ?? q.data!.job?.id ?? null;

  const vulnerable = q.data!.versions.filter((v) => v.security && !v.security.patched);

  return (
    <div className="space-y-4">
      {vulnerable.length > 0 && (
        <Callout tone="danger" title={`PHP ${vulnerable.map((v) => v.version).join(', ')} sin el parche de PHP2Shell`}>
          Vulnerabilidad crítica de ejecución remota de código ({q.data!.php2shell.cves.join(', ')}). Pulsa <strong>Actualizar</strong> en la versión afectada. Mientras
          tanto no se puede asignar a sitios nuevos ni usar por defecto.
        </Callout>
      )}
      <Card padded={false} title="Versiones de PHP" actions={<span className="text-xs text-muted">Cada sitio PHP elige su versión en Configuración</span>}>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {q.data!.versions.map((v) => {
            const isDefault = v.version === q.data!.default;
            return (
              <div key={v.version} className={cx('flex flex-col gap-3 rounded-md border p-4', isDefault ? 'border-accent/40 bg-accent-soft/40' : 'border-border')}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-lg font-semibold tracking-tight">PHP {v.version}</span>
                  {isDefault ? <Badge tone="accent">Por defecto</Badge> : v.installed ? <Badge tone="ok" dot>Instalado</Badge> : <Badge>No instalado</Badge>}
                </div>
                <div className="text-[13px] text-muted">
                  {v.installed ? (v.sites ? `${v.sites} sitio${v.sites === 1 ? '' : 's'} lo usa${v.sites === 1 ? '' : 'n'}` : 'Sin sitios') : v.fixed_in ? 'Disponible para instalar' : 'Sin versión oficial corregida: solo se instala si el paquete trae el parche'}
                </div>
                {v.security && (
                  <div className={cx('flex items-center gap-1.5 text-xs', v.security.patched ? 'text-ok' : 'text-danger')}>
                    {v.security.patched ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
                    <span className="font-mono">{v.security.version || v.version}</span>
                    {v.security.patched ? (v.security.via === 'backport' ? '· parche de la distribución' : '· PHP2Shell corregido') : `· vulnerable${v.fixed_in ? ` (corregido en ${v.fixed_in})` : ''}`}
                  </div>
                )}
                <div className="mt-auto flex gap-1.5">
                  {!v.installed ? (
                    <Button size="sm" icon={<Download className="size-3.5" />} disabled={busy} loading={install.isPending && install.variables === v.version} onClick={() => install.mutate(v.version)}>
                      Instalar
                    </Button>
                  ) : (
                    <>
                      {v.security && !v.security.patched && (
                        <Button size="sm" variant="primary" icon={<ArrowUpCircle className="size-3.5" />} disabled={busy} loading={upgrade.isPending && upgrade.variables === v.version} onClick={() => upgrade.mutate(v.version)}>
                          Actualizar
                        </Button>
                      )}
                      {!isDefault && v.security?.patched !== false && (
                        <Button size="sm" icon={<Star className="size-3.5" />} onClick={() => setDefault.mutate(v.version)}>
                          Por defecto
                        </Button>
                      )}
                      {!isDefault && !v.sites && (
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          aria-label={`Desinstalar PHP ${v.version}`}
                          title={`Desinstalar PHP ${v.version}`}
                          message="Se eliminarán los paquetes de esta versión. Ningún sitio la está usando."
                          label="Desinstalar"
                          disabled={busy}
                          onConfirm={() => remove.mutateAsync(v.version)}
                        >
                          <Trash2 className="size-3.5" />
                        </ConfirmButton>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      {activeJob !== null && (
        <JobLog
          jobId={activeJob}
          onDone={(job) => {
            setJobRunning(false);
            qc.invalidateQueries({ queryKey: ['php'] });
            if (job.status === 'success') toast.success(job.title + ': completado');
            else toast.error(job.title + ': falló');
          }}
        />
      )}
    </div>
  );
}

function Updates() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['updates'], queryFn: () => api.get<UpdatesState>('/api/updates') });
  const [jobId, setJobId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updRunning, setUpdRunning] = useState(false);
  const run = useMutation({
    mutationFn: (component: string) => api.post<{ job_id: number }>('/api/updates/run', { component }),
    onSuccess: (r) => {
      setJobId(r.job_id);
      setUpdRunning(true);
    },
    onError: (e) => toast.error(e.message),
  });
  const settings = useQuery({ queryKey: ['panel-settings'], queryFn: () => api.get<{ auto_update: string; panel_allow_ips: string }>('/api/panel-settings') });
  const saveAuto = useMutation({
    mutationFn: (auto_update: string) => api.put('/api/panel-settings', { auto_update, panel_allow_ips: settings.data?.panel_allow_ips ?? '' }),
    onSuccess: () => {
      toast.success('Preferencia guardada');
      qc.invalidateQueries({ queryKey: ['panel-settings'] });
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const data = q.data!;
  const pending = data.components.filter((c) => c.updateAvailable);
  const activeJob = jobId ?? data.job?.id ?? null;
  const running = updRunning || (!!data.job && jobId === null);

  return (
    <div className="space-y-4">
      <div
        className={cx(
          'flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4',
          pending.length ? 'border-accent/40 bg-accent-soft' : 'border-border bg-surface',
        )}
      >
        <div className="flex items-start gap-3">
          {pending.length ? <ArrowUpCircle className="mt-0.5 size-5 text-accent" /> : <CheckCircle2 className="mt-0.5 size-5 text-ok" />}
          <div>
            <div className="font-semibold">{pending.length ? `${pending.length} actualizaci${pending.length === 1 ? 'ón disponible' : 'ones disponibles'}` : 'Todo está al día'}</div>
            <p className="text-[13px] text-muted">
              {data.checked_at ? `Comprobado ${timeAgo(data.checked_at)}.` : ''} Las actualizaciones conservan sitios, correo, bases de datos y configuración.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            icon={<RefreshCw className={cx('size-4', refreshing && 'animate-spin')} />}
            onClick={async () => {
              setRefreshing(true);
              try {
                qc.setQueryData(['updates'], await api.get<UpdatesState>('/api/updates?refresh=1'));
              } finally {
                setRefreshing(false);
              }
            }}
          >
            Comprobar
          </Button>
          <Button variant="primary" disabled={running} loading={run.isPending && run.variables === 'all'} onClick={() => run.mutate('all')}>
            Actualizar todo
          </Button>
        </div>
      </div>

      <Card padded={false}>
        <Table head={['Componente', 'Instalado', 'Última', '']}>
          {data.components.map((c) => (
            <tr key={c.id}>
              <Td>
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-muted">{c.description}</div>
              </Td>
              <Td className="font-mono text-[13px]">{c.current}</Td>
              <Td className="font-mono text-[13px]">
                {c.latest || '—'} {c.updateAvailable && <Badge tone="accent">Nueva</Badge>}
              </Td>
              <Td className="w-32 text-right">
                <Button size="sm" variant={c.updateAvailable ? 'primary' : 'secondary'} disabled={running} loading={run.isPending && run.variables === c.id} onClick={() => run.mutate(c.id)}>
                  {c.updateAvailable ? 'Actualizar' : 'Reinstalar'}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {activeJob !== null && (
        <JobLog
          jobId={activeJob}
          onDone={(job) => {
            setUpdRunning(false);
            qc.invalidateQueries({ queryKey: ['updates'] });
            if (job.status === 'success') toast.success('Actualización completada');
            else toast.error('La actualización falló: revisa el registro');
          }}
        />
      )}

      <Card title="Actualizaciones automáticas">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-xl text-[13px] text-muted">
            Se ejecutan cada noche entre las 04:00 y las 05:00 (hora del servidor). Los parches de seguridad del sistema operativo se instalan además a diario con unattended-upgrades.
          </p>
          <Select className="!w-64" value={settings.data?.auto_update ?? data.auto} onChange={(e) => saveAuto.mutate(e.target.value)}>
            <option value="off">Desactivadas</option>
            <option value="system">Solo paquetes del sistema</option>
            <option value="all">Todo (panel, Caddy, correo…)</option>
          </Select>
        </div>
      </Card>
    </div>
  );
}

function History() {
  const q = useQuery({ queryKey: ['jobs'], queryFn: () => api.get<Job[]>('/api/jobs'), refetchInterval: 5000 });
  const [open, setOpen] = useState<number | null>(null);
  if (q.isLoading) return <Spinner />;
  return (
    <div className="space-y-4">
      <Card padded={false}>
        {!q.data?.length ? (
          <p className="p-6 text-center text-[13px] text-muted">Todavía no hay tareas.</p>
        ) : (
          <Table head={['Tarea', 'Estado', 'Por', 'Cuándo']}>
            {q.data.map((j) => (
              <tr key={j.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => setOpen(open === j.id ? null : j.id)}>
                <Td className="font-medium">{j.title}</Td>
                <Td>
                  <StatusBadge status={j.status} />
                </Td>
                <Td className="text-muted">{j.created_by}</Td>
                <Td className="text-muted">{timeAgo(j.created_at)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {open !== null && <JobLog key={open} jobId={open} />}
    </div>
  );
}

type SystemTab = 'updates' | 'php' | 'node' | 'history';

export default function SystemPage() {
  const [params, setParams] = useSearchParams();
  const tab = (['updates', 'php', 'node', 'history'].includes(params.get('tab') ?? '') ? params.get('tab') : 'updates') as SystemTab;
  return (
    <>
      <PageHeader title="Sistema" description="Actualizaciones del panel y sus componentes, y versiones de PHP y Node.js del servidor." />
      <Tabs
        value={tab}
        onChange={(t) => setParams(t === 'updates' ? {} : { tab: t }, { replace: true })}
        tabs={[
          { id: 'updates', label: 'Actualizaciones' },
          { id: 'php', label: 'PHP' },
          { id: 'node', label: 'Node.js' },
          { id: 'history', label: 'Historial de tareas' },
        ]}
      />
      {tab === 'updates' && <Updates />}
      {tab === 'php' && <PhpVersions />}
      {tab === 'node' && <NodeVersions />}
      {tab === 'history' && <History />}
    </>
  );
}
