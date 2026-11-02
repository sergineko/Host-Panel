import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ExternalLink, GitCommit, KeyRound, LayoutDashboard, RefreshCw, RotateCcw, Rocket, Trash2 } from 'lucide-react';
import { api, type Deployment, type Site } from '../lib/api';
import { parseDate, timeAgo } from '../lib/format';
import { Badge, Button, Card, ConfirmButton, Copyable, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, StatusBadge, StickyActions, Tabs, cx } from '../components/ui';
import type { WordPressCredentials } from './SiteNew';
import { SiteForm, siteToForm, type SiteFormValue } from '../components/SiteForm';

function LogViewer({ deploymentId }: { deploymentId: number }) {
  const q = useQuery({
    queryKey: ['deployment', deploymentId],
    queryFn: () => api.get<Deployment>(`/api/deployments/${deploymentId}`),
    refetchInterval: (query) => (['queued', 'running'].includes(query.state.data?.status ?? 'running') ? 1500 : false),
  });
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (ref.current && stick.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [q.data?.log]);

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <StatusBadge status={d.status} />
        <span className="text-muted">#{d.id} · {d.trigger}</span>
        {d.commit_sha && <code className="font-mono text-xs text-muted">{d.commit_sha.slice(0, 7)}</code>}
      </div>
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-96 overflow-auto rounded-md border border-border bg-[#0b0d11] p-3 font-mono text-[12px] leading-relaxed text-[#cfd5df]"
      >
        {(d.log || 'Esperando…').split('\n').map((line, i) => (
          <div key={i} className={cx(line.startsWith('✖') && 'text-[#ff8080]', line.startsWith('✔') && 'text-[#6ee7a0]', (line.startsWith('▶') || line.startsWith('$')) && 'text-[#f6a35c]')}>
            {line || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

function DeploymentsTab({ site }: { site: Site }) {
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get('deployment')) || null;
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['deployments', site.id],
    queryFn: () => api.get<Deployment[]>(`/api/sites/${site.id}/deployments`),
    refetchInterval: (query) => (query.state.data?.some((d) => d.status === 'running' || d.status === 'queued') ? 2000 : 10000),
  });
  const rollback = useMutation({
    mutationFn: (release: string) => api.post<{ deployment_id: number }>(`/api/sites/${site.id}/rollback`, { release }),
    onSuccess: (r) => {
      toast.success('Rollback en marcha');
      qc.invalidateQueries({ queryKey: ['deployments', site.id] });
      setParams({ deployment: String(r.deployment_id) });
    },
    onError: (e) => toast.error(e.message),
  });
  const active = selected ?? q.data?.[0]?.id ?? null;

  if (q.isLoading) return <Spinner />;
  if (!q.data?.length) return <Card><Empty icon={<Rocket className="size-6" />} title="Sin despliegues" /></Card>;

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card padded={false} className="lg:col-span-2" title="Historial">
        <ul className="max-h-[480px] divide-y divide-border overflow-y-auto">
          {q.data.map((d) => {
            const canRollback = d.status === 'success' && d.release && d.release !== site.active_release && site.releases?.includes(d.release);
            return (
              <li key={d.id}>
                <button
                  onClick={() => setParams({ deployment: String(d.id) })}
                  className={cx('flex w-full flex-col gap-1 px-4 py-2.5 text-left transition-colors hover:bg-surface-2/60', active === d.id && 'bg-surface-2')}
                >
                  <div className="flex items-center gap-2">
                    <StatusBadge status={d.status} />
                    {d.release && d.release === site.active_release && <Badge tone="accent">Activo</Badge>}
                    <span className="ml-auto text-xs text-muted" title={parseDate(d.created_at).toLocaleString()}>
                      {timeAgo(d.created_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[13px]">
                    {d.commit_sha && <GitCommit className="size-3.5 shrink-0 text-muted" />}
                    <span className="truncate">{d.commit_message || d.trigger}</span>
                  </div>
                  {canRollback && (
                    <span
                      role="button"
                      className="inline-flex w-fit items-center gap-1 text-xs text-accent hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        rollback.mutate(d.release);
                      }}
                    >
                      <RotateCcw className="size-3" /> Volver a esta versión
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      <Card className="lg:col-span-3" title="Log del despliegue">
        {active ? <LogViewer key={active} deploymentId={active} /> : null}
      </Card>
    </div>
  );
}

function WebhookTab({ site }: { site: Site }) {
  const qc = useQueryClient();
  const url = `${window.location.origin}${site.webhook_path}`;
  const rotate = useMutation({
    mutationFn: () => api.post(`/api/sites/${site.id}/webhook-secret`),
    onSuccess: () => {
      toast.success('Secreto regenerado. Actualízalo en GitHub.');
      qc.invalidateQueries({ queryKey: ['site', site.id] });
    },
  });
  const repoPath = site.repo_url.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
  return (
    <Card title="Despliegue automático con GitHub">
      {!site.repo_url && <p className="mb-4 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">Este sitio no tiene repositorio configurado.</p>}
      <ol className="space-y-5">
        <li>
          <div className="mb-1.5 font-medium">1. Abre los ajustes de webhooks del repositorio</div>
          {repoPath ? (
            <a className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline" href={`https://github.com/${repoPath}/settings/hooks/new`} target="_blank" rel="noreferrer">
              github.com/{repoPath}/settings/hooks/new <ExternalLink className="size-3" />
            </a>
          ) : (
            <p className="text-[13px] text-muted">Repositorio → Settings → Webhooks → Add webhook</p>
          )}
        </li>
        <li>
          <div className="mb-1.5 font-medium">2. Payload URL</div>
          <Copyable value={url} />
        </li>
        <li>
          <div className="mb-1.5 font-medium">3. Content type</div>
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[13px]">application/json</code>
        </li>
        <li>
          <div className="mb-1.5 flex items-center justify-between font-medium">
            4. Secret
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={rotate.isPending} onClick={() => rotate.mutate()}>
              Regenerar
            </Button>
          </div>
          <Copyable value={site.webhook_secret} secret />
        </li>
        <li>
          <div className="mb-1 font-medium">5. Eventos</div>
          <p className="text-[13px] text-muted">
            Selecciona <em>Just the push event</em>. Cada push a <code className="font-mono">{site.branch}</code> desplegará el sitio{site.auto_deploy ? '' : ' (el despliegue automático está desactivado en Configuración)'}.
          </p>
        </li>
      </ol>
    </Card>
  );
}

function SettingsTab({ site }: { site: Site }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<SiteFormValue>(() => siteToForm(site));
  const save = useMutation({
    mutationFn: () => api.put<Site & { deployment_id?: number }>(`/api/sites/${site.id}`, value),
    onSuccess: (r) => {
      if (site.source === 'wordpress') toast.success('Configuración guardada y aplicada.');
      else if (r.deployment_id) toast.success('Configuración guardada. Se está republicando en los servidores elegidos.');
      else toast.success('Configuración guardada. Despliega de nuevo para aplicar cambios de build.');
      qc.invalidateQueries({ queryKey: ['site', site.id] });
      qc.invalidateQueries({ queryKey: ['deployments', site.id] });
      qc.invalidateQueries({ queryKey: ['servers'] });
    },
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <SiteForm value={value} onChange={setValue} editing hasToken={site.has_repo_token} wordpress={site.source === 'wordpress'} />
      {save.error && <ErrorBox error={save.error} />}
      <StickyActions>
        <Button variant="primary" type="submit" loading={save.isPending}>
          Guardar cambios
        </Button>
      </StickyActions>
    </form>
  );
}

function CredentialsModal({ creds, onClose }: { creds: WordPressCredentials | null; onClose: () => void }) {
  return (
    <Modal open={!!creds} onClose={onClose} title="Acceso a WordPress" footer={<Button variant="primary" onClick={onClose}>Hecho</Button>}>
      <p className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">Guarda la contraseña ahora: el panel no la almacena.</p>
      <div className="space-y-3">
        <Field label="Panel de administración">
          <Copyable value={creds?.admin_url ?? ''} />
        </Field>
        <Field label="Usuario">
          <Copyable value={creds?.user ?? ''} />
        </Field>
        <Field label="Contraseña">
          <Copyable value={creds?.password ?? ''} />
        </Field>
      </div>
    </Modal>
  );
}

function WordPressOverview({ site }: { site: Site }) {
  const wp = site.wordpress!;
  return (
    <Card className="mb-5" padded={false}>
      <dl className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Sitio', <a key="u" href={wp.site_url} target="_blank" rel="noreferrer" className="hover:text-accent">{wp.site_url.replace('https://', '')}</a>],
          ['Administrador', <span key="a" className="font-mono">{wp.admin_user}</span>],
          ['Base de datos', <Link key="d" to={`/databases/${wp.database_id}`} className="font-mono hover:text-accent">{wp.db_name}</Link>],
          ['PHP', <span key="p" className="font-mono">{site.php_effective}</span>],
        ].map(([label, value]) => (
          <div key={label as string} className="bg-surface px-4 py-3">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="mt-0.5 truncate font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function RuntimeLogs({ site }: { site: Site }) {
  const q = useQuery({ queryKey: ['site-logs', site.id], queryFn: () => api.get<{ logs: string }>(`/api/sites/${site.id}/logs`), refetchInterval: 5000 });
  return (
    <Card title="Logs de la aplicación">
      {q.isLoading ? <Spinner /> : <pre className="h-[480px] overflow-auto rounded-md border border-border bg-[#0b0d11] p-3 font-mono text-[12px] text-[#cfd5df]">{q.data?.logs || 'Sin salida.'}</pre>}
    </Card>
  );
}

export default function SiteDetail() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [creds, setCreds] = useState<WordPressCredentials | null>((location.state as { credentials?: WordPressCredentials } | null)?.credentials ?? null);
  const tab = (params.get('tab') ?? 'deployments') as 'deployments' | 'webhook' | 'settings' | 'logs';
  const resetWp = useMutation({
    mutationFn: () => api.post<{ user: string; password: string }>(`/api/sites/${id}/wordpress/password`),
    onSuccess: (r) => setCreds({ admin_url: q.data?.wordpress?.admin_url ?? '', user: r.user, password: r.password }),
    onError: (e) => toast.error(e.message),
  });
  const q = useQuery({ queryKey: ['site', id], queryFn: () => api.get<Site>(`/api/sites/${id}`), refetchInterval: 10000 });
  const deploy = useMutation({
    mutationFn: () => api.post<{ deployment_id: number }>(`/api/sites/${id}/deploy`),
    onSuccess: (r) => {
      toast.success('Despliegue en cola');
      qc.invalidateQueries({ queryKey: ['deployments', id] });
      setParams({ deployment: String(r.deployment_id) });
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const site = q.data!;
  const isWp = site.source === 'wordpress';

  return (
    <>
      <Link to="/sites" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Sitios
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {site.name} <StatusBadge status={site.status} />
          </span>
        }
        description={
          <span className="flex flex-wrap gap-x-3">
            {site.hostnames.map((h) => (
              <a key={h} href={`https://${h}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-accent">
                {h} <ExternalLink className="size-3" />
              </a>
            ))}
          </span>
        }
        actions={
          <>
            <ConfirmButton
              variant="danger"
              icon={<Trash2 className="size-4" />}
              title={`Eliminar ${site.name}`}
              message={
                isWp
                  ? 'Se borrarán WordPress, sus archivos subidos y su base de datos. No se puede deshacer: exporta la base de datos antes si la necesitas.'
                  : 'Se borrarán los archivos, releases, procesos y el usuario del sistema de este sitio. Las bases de datos no se tocan.'
              }
              onConfirm={async () => {
                await api.del(`/api/sites/${id}`);
                qc.invalidateQueries({ queryKey: ['sites'] });
                toast.success('Sitio eliminado');
                navigate('/sites');
              }}
            >
              Eliminar
            </ConfirmButton>
            {isWp ? (
              <>
                <Button icon={<KeyRound className="size-4" />} loading={resetWp.isPending} disabled={!site.active_release} onClick={() => resetWp.mutate()}>
                  Restablecer contraseña
                </Button>
                <a href={site.wordpress?.admin_url} target="_blank" rel="noreferrer">
                  <Button variant="primary" icon={<LayoutDashboard className="size-4" />} disabled={!site.active_release}>
                    Panel de WordPress
                  </Button>
                </a>
              </>
            ) : (
              <Button variant="primary" icon={<Rocket className="size-4" />} loading={deploy.isPending} onClick={() => deploy.mutate()}>
                Desplegar ahora
              </Button>
            )}
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { id: 'deployments', label: isWp ? 'Actividad' : 'Despliegues' },
          ...(isWp ? [] : [{ id: 'webhook' as const, label: 'Webhook GitHub' }]),
          { id: 'settings', label: 'Configuración' },
          ...(site.type === 'node' ? [{ id: 'logs' as const, label: 'Logs' }] : []),
        ]}
      />
      {isWp && <WordPressOverview site={site} />}
      {tab === 'deployments' && <DeploymentsTab site={site} />}
      {tab === 'webhook' && <WebhookTab site={site} />}
      {tab === 'settings' && <SettingsTab key={site.id} site={site} />}
      {tab === 'logs' && <RuntimeLogs site={site} />}
      <CredentialsModal
        creds={creds}
        onClose={() => {
          setCreds(null);
          // Don't show the password again on reload / back navigation.
          navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
        }}
      />
    </>
  );
}
