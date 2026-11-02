import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowUpCircle, Bug, Copy, ExternalLink, FlaskConical, Palette, Plug, Power, PowerOff, RefreshCw, Rocket, Settings2, Trash2, Wrench } from 'lucide-react';
import { api, type Site } from '../lib/api';
import { bytes, timeAgo } from '../lib/format';
import { JobLog } from './JobLog';
import { Badge, Button, Callout, Card, ConfirmButton, Empty, ErrorBox, Field, Input, Modal, Spinner, Toggle, cx } from './ui';

interface WpItem {
  name: string;
  title: string;
  status: string;
  version: string;
  update_version: string | null;
  auto_update: boolean;
}

interface WpToolkit {
  installed: boolean;
  core: { version: string; update_version: string | null; update_type: 'major' | 'minor' | null };
  plugins: WpItem[];
  themes: WpItem[];
  maintenance: boolean;
  debug_log: boolean;
  debug_log_size: number;
  auto_update: { core_minor: boolean; plugins_minor: boolean; last_run: string | null };
  staging: { id: number; name: string; url: string; status: string } | null;
  staging_of: { id: number; name: string; url: string } | null;
  job: { id: number; title: string } | null;
}

type UpdateBody = { core?: boolean; plugins?: string[] | 'all'; themes?: string[] | 'all' };

const host = (url: string) => url.replace(/^https?:\/\//, '');

export function WordPressTab({ site }: { site: Site }) {
  const qc = useQueryClient();
  const key = ['wp-toolkit', site.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<WpToolkit>(`/api/sites/${site.id}/wordpress/toolkit`) });
  const [jobId, setJobId] = useState<number | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [stagingHost, setStagingHost] = useState(`staging.${site.hostnames[0] ?? ''}`);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const onError = (e: unknown) => toast.error((e as Error).message);

  const update = useMutation({
    mutationFn: (body: UpdateBody) => api.post<{ job_id: number }>(`/api/sites/${site.id}/wordpress/toolkit/update`, body),
    onSuccess: (r) => setJobId(r.job_id),
    onError,
  });
  const item = useMutation({
    mutationFn: ({ kind, name, action }: { kind: 'plugins' | 'themes'; name: string; action: 'activate' | 'deactivate' | 'delete' }) =>
      api.post(`/api/sites/${site.id}/wordpress/toolkit/${kind}/${encodeURIComponent(name)}/${action}`),
    onMutate: ({ kind, name }) => setBusyItem(`${kind}:${name}`),
    onSuccess: (_r, v) => {
      toast.success({ activate: 'Activado', deactivate: 'Desactivado', delete: 'Eliminado' }[v.action] + `: ${v.name}`);
      refresh();
    },
    onError,
    onSettled: () => setBusyItem(null),
  });
  const settings = useMutation({
    mutationFn: (body: Partial<{ maintenance: boolean; debug_log: boolean; auto_update: { core_minor: boolean; plugins_minor: boolean } }>) =>
      api.put(`/api/sites/${site.id}/wordpress/toolkit/settings`, body),
    onSuccess: (_r, body) => {
      if (body.maintenance !== undefined) toast.success(body.maintenance ? 'Modo mantenimiento activado' : 'Sitio visible de nuevo');
      else if (body.debug_log !== undefined) toast.success(body.debug_log ? 'Registro de depuración activado' : 'Registro de depuración desactivado');
      else toast.success('Actualizaciones automáticas guardadas');
      refresh();
    },
    onError,
  });
  const createStaging = useMutation({
    mutationFn: () => api.post<{ job_id: number }>(`/api/sites/${site.id}/wordpress/toolkit/staging`, { hostname: stagingHost.trim().toLowerCase() }),
    onSuccess: (r) => {
      setJobId(r.job_id);
      refresh();
      qc.invalidateQueries({ queryKey: ['sites'] });
    },
    onError,
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  if (!d.installed) {
    return (
      <Card>
        <Empty icon={<Wrench className="size-6" />} title="WordPress todavía se está instalando" description="Las herramientas estarán disponibles cuando termine la instalación (pestaña Actividad)." />
      </Card>
    );
  }

  const activeJob = jobId ?? d.job?.id ?? null;
  const locked = activeJob !== null;
  const pluginUpdates = d.plugins.filter((p) => p.update_version);
  const themeUpdates = d.themes.filter((t) => t.update_version);
  const totalUpdates = (d.core.update_version ? 1 : 0) + pluginUpdates.length + themeUpdates.length;
  const isStaging = !!d.staging_of;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-4">
        {isStaging && (
          <Callout
            tone="info"
            title="Esto es un sitio de pruebas (staging)"
            action={
              <Button size="sm" variant="primary" icon={<Rocket className="size-3.5" />} disabled={locked} onClick={() => setPushOpen(true)}>
                Publicar en producción
              </Button>
            }
          >
            Copia de <Link to={`/sites/${d.staging_of!.id}?tab=wordpress`} className="font-medium text-accent hover:underline">{d.staging_of!.name}</Link>. No lo indexan los buscadores y no se actualiza solo.
          </Callout>
        )}
        {activeJob !== null && (
          <JobLog
            key={activeJob}
            jobId={activeJob}
            onDone={(job) => {
              setJobId(null);
              refresh();
              qc.invalidateQueries({ queryKey: ['backups', site.id] });
              qc.invalidateQueries({ queryKey: ['site', site.id] });
              qc.invalidateQueries({ queryKey: ['sites'] });
              if (job.status === 'success') toast.success(`${job.title}: completado`);
              else toast.error(`${job.title}: falló. Revisa el registro; la copia previa está en «Copias».`);
            }}
          />
        )}

        <Card
          icon={<ArrowUpCircle />}
          title="Versiones y actualizaciones"
          description={totalUpdates ? `${totalUpdates} actualización${totalUpdates === 1 ? '' : 'es'} disponible${totalUpdates === 1 ? '' : 's'}` : 'Todo está al día'}
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<RefreshCw className={cx('size-3.5', q.isFetching && 'animate-spin')} />} onClick={refresh} aria-label="Buscar actualizaciones">
                Comprobar
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<ArrowUpCircle className="size-3.5" />}
                disabled={!totalUpdates || locked}
                loading={update.isPending}
                onClick={() => update.mutate({ core: !!d.core.update_version, plugins: pluginUpdates.length ? 'all' : [], themes: themeUpdates.length ? 'all' : [] })}
              >
                Actualizar todo
              </Button>
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-[#21759b] text-lg font-bold text-white" aria-hidden>
              W
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 font-medium">
                WordPress <span className="font-mono">{d.core.version}</span>
                {d.core.update_version ? (
                  <Badge tone={d.core.update_type === 'major' ? 'warn' : 'info'}>
                    {d.core.update_version} disponible{d.core.update_type === 'minor' ? ' · seguridad' : ''}
                  </Badge>
                ) : (
                  <Badge tone="ok">Al día</Badge>
                )}
              </div>
              <p className="text-xs text-muted">Antes de cada actualización se hace una copia de seguridad automática que puedes restaurar en «Copias».</p>
            </div>
            {d.core.update_version && (
              <Button size="sm" disabled={locked} onClick={() => update.mutate({ core: true })}>
                Actualizar núcleo
              </Button>
            )}
          </div>
        </Card>

        <ItemsCard
          kind="plugins"
          items={d.plugins}
          locked={locked}
          busyItem={busyItem}
          onUpdate={(names) => update.mutate({ plugins: names })}
          onAction={(name, action) => item.mutate({ kind: 'plugins', name, action })}
        />
        <ItemsCard
          kind="themes"
          items={d.themes}
          locked={locked}
          busyItem={busyItem}
          onUpdate={(names) => update.mutate({ themes: names })}
          onAction={(name, action) => item.mutate({ kind: 'themes', name, action })}
        />
      </div>

      <div className="space-y-4">
        <Card title="Herramientas" icon={<Settings2 />} className="h-fit">
          <div className="-my-3 divide-y divide-border">
            <Toggle
              label="Modo mantenimiento"
              description="Los visitantes ven «En mantenimiento» mientras trabajas. Los administradores conectados siguen viendo el sitio."
              checked={d.maintenance}
              disabled={settings.isPending || locked}
              onChange={(v) => settings.mutate({ maintenance: v })}
            />
            <div>
              <Toggle
                label="Registro de depuración"
                description="Guarda errores y avisos de PHP en wp-content/debug.log sin mostrarlos a los visitantes."
                checked={d.debug_log}
                disabled={settings.isPending || locked}
                onChange={(v) => settings.mutate({ debug_log: v })}
              />
              {(d.debug_log || d.debug_log_size > 0) && (
                <Button size="sm" className="mb-3" icon={<Bug className="size-3.5" />} onClick={() => setLogOpen(true)}>
                  Ver registro{d.debug_log_size ? ` (${bytes(d.debug_log_size)})` : ''}
                </Button>
              )}
            </div>
          </div>
        </Card>

        {!isStaging && (
          <Card title="Actualizaciones automáticas" icon={<RefreshCw />} className="h-fit">
            <div className="-my-3 divide-y divide-border">
              <Toggle
                label="Versiones menores del núcleo"
                description="Parches de seguridad y correcciones (p. ej. 6.6.1 → 6.6.2)."
                checked={d.auto_update.core_minor}
                disabled={settings.isPending}
                onChange={(v) => settings.mutate({ auto_update: { ...d.auto_update, core_minor: v } })}
              />
              <Toggle
                label="Versiones menores de plugins"
                description="Solo cambios del último número (p. ej. 2.3.1 → 2.3.4)."
                checked={d.auto_update.plugins_minor}
                disabled={settings.isPending}
                onChange={(v) => settings.mutate({ auto_update: { ...d.auto_update, plugins_minor: v } })}
              />
            </div>
            <p className="mt-3 text-xs text-muted">
              Se comprueban una vez al día, con copia de seguridad previa solo si hay algo que actualizar.
              {d.auto_update.last_run && ` Última comprobación ${timeAgo(d.auto_update.last_run)}.`}
            </p>
          </Card>
        )}

        {!isStaging && (
          <Card title="Staging" icon={<FlaskConical />} className="h-fit" description="Una copia para probar cambios sin tocar producción">
            {d.staging ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-border bg-surface-2/50 px-3 py-2.5">
                  <a href={d.staging.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium hover:text-accent">
                    {host(d.staging.url)} <ExternalLink className="size-3" />
                  </a>
                  <div className="mt-0.5 text-xs text-muted">
                    {d.staging.status === 'live' ? 'En línea' : d.staging.status === 'failed' ? 'Con errores' : 'Preparándose…'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" icon={<Rocket className="size-3.5" />} disabled={locked || d.staging.status !== 'live'} onClick={() => setPushOpen(true)}>
                    Publicar en producción
                  </Button>
                  <Link to={`/sites/${d.staging.id}?tab=wordpress`}>
                    <Button size="sm">Gestionar staging</Button>
                  </Link>
                </div>
                <p className="text-xs text-muted">Para empezar de cero, elimina el sitio de staging desde su página y crea otro.</p>
              </div>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  createStaging.mutate();
                }}
              >
                <Field label="Dominio del staging" hint="Debe apuntar a este servidor (registro A o comodín en DNS).">
                  <Input value={stagingHost} onChange={(e) => setStagingHost(e.target.value)} spellCheck={false} />
                </Field>
                <Button type="submit" variant="primary" size="sm" icon={<Copy className="size-3.5" />} loading={createStaging.isPending} disabled={locked || !stagingHost.trim()}>
                  Crear staging
                </Button>
                <p className="text-xs text-muted">Se copian archivos y base de datos, y se cambian las URLs al nuevo dominio.</p>
              </form>
            )}
          </Card>
        )}
      </div>

      <DebugLogModal siteId={site.id} open={logOpen} onClose={() => setLogOpen(false)} />
      <PushModal
        siteId={site.id}
        open={pushOpen}
        onClose={() => setPushOpen(false)}
        from={isStaging ? site.hostnames[0] ?? '' : host(d.staging?.url ?? '')}
        to={isStaging ? host(d.staging_of!.url) : site.hostnames[0] ?? ''}
        onStarted={(id) => {
          setPushOpen(false);
          setJobId(id);
        }}
      />
    </div>
  );
}

function ItemsCard({
  kind,
  items,
  locked,
  busyItem,
  onUpdate,
  onAction,
}: {
  kind: 'plugins' | 'themes';
  items: WpItem[];
  locked: boolean;
  busyItem: string | null;
  onUpdate: (names: string[]) => void;
  onAction: (name: string, action: 'activate' | 'deactivate' | 'delete') => void;
}) {
  const plugins = kind === 'plugins';
  const updates = items.filter((i) => i.update_version);
  const active = items.filter((i) => i.status.startsWith('active')).length;
  return (
    <Card
      padded={false}
      icon={plugins ? <Plug /> : <Palette />}
      title={plugins ? 'Plugins' : 'Temas'}
      description={`${items.length} instalado${items.length === 1 ? '' : 's'} · ${active} activo${active === 1 ? '' : 's'}${updates.length ? ` · ${updates.length} con actualización` : ''}`}
      actions={
        updates.length > 1 && (
          <Button size="sm" disabled={locked} onClick={() => onUpdate(updates.map((u) => u.name))}>
            Actualizar {updates.length}
          </Button>
        )
      }
    >
      {items.length === 0 ? (
        <Empty title={plugins ? 'Sin plugins' : 'Sin temas'} description="Instálalos desde el panel de WordPress." />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((i) => {
            const isActive = i.status.startsWith('active');
            const busy = busyItem === `${kind}:${i.name}`;
            return (
              <li key={i.name} className={cx('flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5', busy && 'opacity-60')}>
                <span className={cx('size-2 shrink-0 rounded-full', isActive ? 'bg-ok' : 'bg-border-strong')} title={isActive ? 'Activo' : 'Inactivo'} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{i.title}</span>
                    {!plugins && isActive && <Badge tone="accent">Tema activo</Badge>}
                    {i.auto_update && <Badge tone="neutral">Auto</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span className="font-mono">{i.name}</span>·<span className="font-mono">{i.version}</span>
                    {i.update_version && (
                      <span className="font-mono text-info">
                        → {i.update_version}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {i.update_version && (
                    <Button size="sm" icon={<ArrowUpCircle className="size-3.5 text-info" />} disabled={locked} onClick={() => onUpdate([i.name])}>
                      Actualizar
                    </Button>
                  )}
                  {plugins ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={isActive ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                      disabled={locked || busy}
                      onClick={() => onAction(i.name, isActive ? 'deactivate' : 'activate')}
                    >
                      {isActive ? 'Desactivar' : 'Activar'}
                    </Button>
                  ) : (
                    !isActive && (
                      <Button size="sm" variant="ghost" icon={<Power className="size-3.5" />} disabled={locked || busy} onClick={() => onAction(i.name, 'activate')}>
                        Activar
                      </Button>
                    )
                  )}
                  {(plugins || !isActive) && (
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      aria-label={`Eliminar ${i.title}`}
                      title={`Eliminar ${i.title}`}
                      disabled={locked || busy}
                      message={plugins ? 'Se desactivará y se borrarán sus archivos. Sus datos en la base de datos pueden quedarse.' : 'Se borrarán los archivos del tema.'}
                      onConfirm={() => onAction(i.name, 'delete')}
                    >
                      <Trash2 className="size-3.5" />
                    </ConfirmButton>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DebugLogModal({ siteId, open, onClose }: { siteId: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['wp-debug-log', siteId],
    queryFn: () => api.get<{ log: string }>(`/api/sites/${siteId}/wordpress/toolkit/debug-log`),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const clear = useMutation({
    mutationFn: () => api.del(`/api/sites/${siteId}/wordpress/toolkit/debug-log`),
    onSuccess: () => {
      toast.success('Registro vaciado');
      qc.invalidateQueries({ queryKey: ['wp-debug-log', siteId] });
      qc.invalidateQueries({ queryKey: ['wp-toolkit', siteId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="wp-content/debug.log"
      footer={
        <>
          <Button variant="danger" icon={<Trash2 className="size-4" />} loading={clear.isPending} onClick={() => clear.mutate()}>
            Vaciar
          </Button>
          <Button variant="primary" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : (
        <pre className="h-96 overflow-auto rounded-md border border-border bg-[#0b0d11] p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-[#cfd5df]">
          {(q.data?.log || 'El registro está vacío.').split('\n').map((line, n) => (
            <div key={n} className={cx(/Fatal error/.test(line) && 'text-[#ff8080]', /Warning/.test(line) && 'text-[#f6c35c]')}>
              {line || ' '}
            </div>
          ))}
        </pre>
      )}
    </Modal>
  );
}

function PushModal({ siteId, open, onClose, from, to, onStarted }: { siteId: number; open: boolean; onClose: () => void; from: string; to: string; onStarted: (jobId: number) => void }) {
  const [parts, setParts] = useState({ files: true, database: true });
  const push = useMutation({
    mutationFn: () => api.post<{ job_id: number }>(`/api/sites/${siteId}/wordpress/toolkit/staging/push`, parts),
    onSuccess: (r) => onStarted(r.job_id),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Publicar staging en producción"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" icon={<Rocket className="size-4" />} loading={push.isPending} disabled={!parts.files && !parts.database} onClick={() => push.mutate()}>
            Publicar
          </Button>
        </>
      }
    >
      <p className="mb-3 text-muted">
        Se copiará <span className="font-mono text-fg">{from}</span> sobre <span className="font-mono text-fg">{to}</span>. Antes se hace una copia de seguridad de producción.
      </p>
      <div className="-my-1 divide-y divide-border">
        <Toggle label="Archivos" description="Plugins, temas y subidas. Se conserva el wp-config.php de producción." checked={parts.files} onChange={(v) => setParts({ ...parts, files: v })} />
        <Toggle
          label="Base de datos"
          description="Entradas, páginas, ajustes y usuarios. Lo publicado en producción desde que creaste el staging (pedidos, comentarios…) se perderá."
          checked={parts.database}
          onChange={(v) => setParts({ ...parts, database: v })}
        />
      </div>
    </Modal>
  );
}
