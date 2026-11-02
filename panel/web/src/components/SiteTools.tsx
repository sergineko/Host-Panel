import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Archive, CalendarClock, Clock, Database, Download, History, Pause, Play, Plus, RotateCcw, Save, Settings2, Terminal, Trash2 } from 'lucide-react';
import { api, type Site } from '../lib/api';
import { bytes, parseDate, timeAgo } from '../lib/format';
import { JobLog } from './JobLog';
import { Badge, Button, Callout, Card, ChoiceCard, ConfirmButton, Empty, ErrorBox, Field, Input, Modal, Select, Spinner, Toggle, cx } from './ui';

const dateTime = (v: string) => parseDate(v).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// --- backups ---------------------------------------------------------------------------------

interface BackupItem {
  id: number;
  file: string;
  size: number;
  kind: 'manual' | 'auto' | 'pre-restore' | 'pre-update';
  status: 'running' | 'success' | 'failed';
  includes: string[];
  note: string;
  error: string;
  created_at: string;
}
interface BackupsData {
  schedule: 'off' | 'daily' | 'weekly';
  keep: number;
  database_ids: number[];
  included_databases: { id: number; name: string }[];
  available_databases: { id: number; name: string }[];
  wordpress: boolean;
  job: { id: number } | null;
  backups: BackupItem[];
}

const kindLabel = { manual: 'Manual', auto: 'Automática', 'pre-restore': 'Antes de restaurar', 'pre-update': 'Antes de actualizar' } as const;
const includeLabel = (i: string) => (i === 'files' ? 'Archivos' : i === 'shared' ? 'Compartido' : i.startsWith('db:') ? i.slice(3) : i);

export function BackupsTab({ site }: { site: Site }) {
  const qc = useQueryClient();
  const key = ['backups', site.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<BackupsData>(`/api/sites/${site.id}/backups`) });
  const [jobId, setJobId] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<BackupItem | null>(null);
  const [parts, setParts] = useState({ files: true, databases: true });
  const [settings, setSettings] = useState<{ schedule: BackupsData['schedule']; keep: number; database_ids: number[] } | null>(null);
  useEffect(() => {
    if (q.data && !settings) setSettings({ schedule: q.data.schedule, keep: q.data.keep, database_ids: q.data.database_ids });
  }, [q.data, settings]);

  const create = useMutation({
    mutationFn: () => api.post<{ job_id: number }>(`/api/sites/${site.id}/backups`),
    onSuccess: (r) => setJobId(r.job_id),
    onError: (e) => toast.error((e as Error).message),
  });
  const restore = useMutation({
    mutationFn: () => api.post<{ job_id: number }>(`/api/sites/${site.id}/backups/${restoring!.id}/restore`, parts),
    onSuccess: (r) => {
      setRestoring(null);
      setJobId(r.job_id);
    },
  });
  const saveSettings = useMutation({
    mutationFn: () => api.put(`/api/sites/${site.id}/backups/settings`, settings),
    onSuccess: () => {
      toast.success('Programación guardada');
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (q.isLoading || !settings) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const activeJob = jobId ?? d.job?.id ?? null;
  const dirty = settings.schedule !== d.schedule || settings.keep !== d.keep || JSON.stringify(settings.database_ids) !== JSON.stringify(d.database_ids);
  const lastOk = d.backups.find((b) => b.status === 'success');

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-4">
        {activeJob !== null && (
          <JobLog
            jobId={activeJob}
            onDone={(job) => {
              setJobId(null);
              qc.invalidateQueries({ queryKey: key });
              qc.invalidateQueries({ queryKey: ['site', site.id] });
              if (job.status === 'success') toast.success(job.title + ': completado');
              else toast.error(job.title + ': falló');
            }}
          />
        )}
        <Card
          padded={false}
          icon={<Archive />}
          title="Copias de seguridad"
          description={lastOk ? `Última copia correcta ${timeAgo(lastOk.created_at)}` : 'Todavía no hay ninguna copia'}
          actions={
            <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} loading={create.isPending} disabled={activeJob !== null} onClick={() => create.mutate()}>
              Crear copia ahora
            </Button>
          }
        >
          {d.backups.length === 0 ? (
            <Empty icon={<Archive className="size-6" />} title="Sin copias" description="Crea una ahora o programa copias automáticas a la derecha." />
          ) : (
            <ul className="divide-y divide-border">
              {d.backups.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                  <span
                    className={cx(
                      'grid size-8 shrink-0 place-items-center rounded-lg [&>svg]:size-4',
                      b.status === 'failed' ? 'bg-danger-soft text-danger' : b.status === 'running' ? 'bg-info-soft text-info' : 'bg-surface-2 text-muted',
                    )}
                  >
                    {b.kind === 'auto' ? <CalendarClock /> : b.kind === 'pre-restore' || b.kind === 'pre-update' ? <History /> : <Archive />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {dateTime(b.created_at)}
                      <Badge tone={b.kind === 'auto' ? 'info' : b.kind === 'pre-restore' || b.kind === 'pre-update' ? 'violet' : 'neutral'}>{kindLabel[b.kind]}</Badge>
                      {b.status === 'failed' && <Badge tone="danger">Fallida</Badge>}
                      {b.status === 'running' && <Badge tone="info">Creando…</Badge>}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {b.status === 'failed' ? b.error : [bytes(b.size), b.includes.map(includeLabel).join(' + '), b.note].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {b.status === 'success' && (
                    <div className="flex gap-1">
                      <Button size="sm" icon={<RotateCcw className="size-3.5" />} disabled={activeJob !== null} onClick={() => (setParts({ files: true, databases: true }), setRestoring(b))}>
                        Restaurar
                      </Button>
                      <a
                        href={`/api/sites/${site.id}/backups/${b.id}/download`}
                        className="grid h-7 w-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
                        aria-label="Descargar copia"
                        title="Descargar (.tar)"
                      >
                        <Download className="size-3.5" />
                      </a>
                    </div>
                  )}
                  {b.status !== 'running' && (
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      aria-label="Eliminar copia"
                      title="Eliminar copia"
                      message={`Se borrará la copia del ${dateTime(b.created_at)}.`}
                      onConfirm={async () => {
                        await api.del(`/api/sites/${site.id}/backups/${b.id}`);
                        qc.invalidateQueries({ queryKey: key });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </ConfirmButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Copias automáticas" icon={<CalendarClock />} className="h-fit">
        <div className="space-y-4">
          <div className="grid gap-2">
            {(
              [
                ['off', 'Desactivadas', 'Solo copias manuales.'],
                ['daily', 'Diarias', 'Una copia cada 24 horas.'],
                ['weekly', 'Semanales', 'Una copia cada 7 días.'],
              ] as const
            ).map(([id, title, desc]) => (
              <ChoiceCard key={id} selected={settings.schedule === id} onClick={() => setSettings({ ...settings, schedule: id })} title={title} description={desc} />
            ))}
          </div>
          {settings.schedule !== 'off' && (
            <Field label="Conservar" hint="Las automáticas más antiguas se borran solas. Las manuales se conservan.">
              <Select value={settings.keep} onChange={(e) => setSettings({ ...settings, keep: Number(e.target.value) })}>
                {[3, 7, 14, 30, 60].map((n) => (
                  <option key={n} value={n}>
                    Las últimas {n}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
              <Database className="size-3.5 text-muted" /> Bases de datos incluidas
            </div>
            {d.wordpress && <p className="mb-2 text-xs text-muted">La base de datos de WordPress se incluye siempre.</p>}
            {d.available_databases.length === 0 ? (
              <p className="text-xs text-muted">No hay bases de datos SQL.</p>
            ) : (
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {d.available_databases.map((db) => {
                  const forced = d.wordpress && d.included_databases.some((x) => x.id === db.id) && !d.database_ids.includes(db.id);
                  const checked = forced || settings.database_ids.includes(db.id);
                  return (
                    <label key={db.id} className={cx('flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-2', forced && 'opacity-70')}>
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--accent)]"
                        checked={checked}
                        disabled={forced}
                        onChange={() =>
                          setSettings({
                            ...settings,
                            database_ids: checked ? settings.database_ids.filter((x) => x !== db.id) : [...settings.database_ids, db.id],
                          })
                        }
                      />
                      <span className="font-mono">{db.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <Button variant="primary" className="w-full" icon={<Save className="size-4" />} disabled={!dirty} loading={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
            Guardar
          </Button>
          <p className="text-xs text-muted">Cada copia incluye los archivos del sitio, su carpeta compartida y las bases de datos marcadas.</p>
        </div>
      </Card>

      <Modal
        open={!!restoring}
        onClose={() => setRestoring(null)}
        title="Restaurar copia"
        footer={
          <>
            <Button onClick={() => setRestoring(null)}>Cancelar</Button>
            <Button variant="primary" icon={<RotateCcw className="size-4" />} loading={restore.isPending} disabled={!parts.files && !parts.databases} onClick={() => restore.mutate()}>
              Restaurar
            </Button>
          </>
        }
      >
        {restoring && (
          <div className="space-y-3">
            {restore.error && <ErrorBox error={restore.error} />}
            <p className="text-[13px] text-muted">
              Copia del <span className="font-medium text-fg">{dateTime(restoring.created_at)}</span> ({bytes(restoring.size)}).
            </p>
            <div className="divide-y divide-border rounded-lg border border-border px-3">
              <Toggle checked={parts.files} onChange={(v) => setParts({ ...parts, files: v })} label="Archivos" description="Se publican como una versión nueva; la actual queda en el historial de despliegues." />
              {restoring.includes.some((i) => i.startsWith('db:')) && (
                <Toggle
                  checked={parts.databases}
                  onChange={(v) => setParts({ ...parts, databases: v })}
                  label="Bases de datos"
                  description={restoring.includes.filter((i) => i.startsWith('db:')).map(includeLabel).join(', ')}
                />
              )}
            </div>
            <Callout tone="ok">Antes de restaurar se crea automáticamente una copia del estado actual, para poder deshacerlo.</Callout>
          </div>
        )}
      </Modal>
    </div>
  );
}

// --- cron jobs -------------------------------------------------------------------------------

interface CronItem {
  id: number;
  schedule: string;
  command: string;
  note: string;
  enabled: boolean;
  last_run: string | null;
  last_status: '' | 'success' | 'failed' | 'running';
  last_duration: number;
  last_output: string;
  next: string[];
}
interface CronsData {
  presets: { label: string; schedule: string }[];
  crons: CronItem[];
}
type CronForm = { schedule: string; command: string; note: string; enabled: boolean };

/** Human description of common cron expressions (others are shown as they are). */
export function describeCron(expr: string) {
  const m = expr.trim().split(/\s+/);
  if (m.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = m as [string, string, string, string, string];
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const at = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `a las ${hour.padStart(2, '0')}:${min.padStart(2, '0')} UTC` : '';
  if (expr === '* * * * *') return 'Cada minuto';
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Cada ${min.slice(2)} minutos`;
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Cada hora (minuto ${min})`;
  if (at && dom === '*' && mon === '*' && dow === '*') return `Cada día ${at}`;
  if (at && dom === '*' && mon === '*' && /^\d$/.test(dow)) return `Cada ${days[Number(dow)]} ${at}`;
  if (at && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `El día ${dom} de cada mes ${at}`;
  return expr;
}

function CronModal({ site, initial, id, presets, onClose }: { site: Site; initial: CronForm; id?: number; presets: CronsData['presets']; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(initial);
  const preview = useQuery({
    queryKey: ['cron-preview', f.schedule],
    queryFn: () => api.get<{ ok: boolean; error?: string; next: string[] }>(`/api/crons/preview?schedule=${encodeURIComponent(f.schedule)}`),
    enabled: f.schedule.trim().split(/\s+/).length === 5,
  });
  const save = useMutation({
    mutationFn: () => (id ? api.put(`/api/sites/${site.id}/crons/${id}`, f) : api.post(`/api/sites/${site.id}/crons`, f)),
    onSuccess: () => {
      toast.success('Tarea guardada');
      qc.invalidateQueries({ queryKey: ['crons', site.id] });
      onClose();
    },
  });
  const examples =
    site.type === 'php'
      ? [`php${site.php_effective ?? ''} artisan schedule:run`, `php${site.php_effective ?? ''} wp-cron.php`, 'php scripts/limpiar.php']
      : site.type === 'node'
        ? ['node scripts/informe.js', 'npm run cron']
        : ['sh scripts/tarea.sh'];
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={id ? 'Editar tarea' : 'Nueva tarea programada'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.command.trim() || preview.data?.ok === false} onClick={() => save.mutate()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <ErrorBox error={save.error} />}
        <div>
          <div className="mb-1.5 text-[13px] font-medium">Frecuencia</div>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.schedule}
                type="button"
                onClick={() => setF({ ...f, schedule: p.schedule })}
                className={cx(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  f.schedule === p.schedule ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-border hover:border-border-strong',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <Field
          label="Expresión cron (UTC)"
          hint={
            preview.data?.ok === false ? (
              <span className="text-danger">{preview.data.error}</span>
            ) : preview.data?.next.length ? (
              <>Próximas: {preview.data.next.map((n) => new Date(n).toLocaleString('es', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })).join(' · ')} (tu hora)</>
            ) : (
              'minuto hora día-del-mes mes día-de-la-semana'
            )
          }
        >
          <Input className="font-mono" value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })} />
        </Field>
        <Field label="Comando" hint={<>Se ejecuta como el usuario del sitio en su carpeta publicada, con sus variables de entorno. Ejemplos: {examples.map((x) => <code key={x} className="mr-2 font-mono">{x}</code>)}</>}>
          <Input className="font-mono" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder={examples[0]} />
        </Field>
        <Field label="Descripción (opcional)">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Limpiar sesiones caducadas" />
        </Field>
        <div className="border-t border-border">
          <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Activa" />
        </div>
      </div>
    </Modal>
  );
}

export function CronsTab({ site }: { site: Site }) {
  const qc = useQueryClient();
  const key = ['crons', site.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<CronsData>(`/api/sites/${site.id}/crons`),
    refetchInterval: (query) => (query.state.data?.crons.some((c) => c.last_status === 'running') ? 3000 : 30_000),
  });
  const [editing, setEditing] = useState<{ form: CronForm; id?: number } | null>(null);
  const [output, setOutput] = useState<CronItem | null>(null);
  const runNow = useMutation({
    mutationFn: (id: number) => api.post<CronItem>(`/api/sites/${site.id}/crons/${id}/run`),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: key });
      if (c.last_status === 'running') toast.info('Sigue ejecutándose; el resultado aparecerá en la lista');
      else {
        setOutput(c);
        if (c.last_status === 'success') toast.success('Tarea ejecutada');
        else toast.error('La tarea terminó con error');
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const toggle = useMutation({
    mutationFn: (c: CronItem) => api.put(`/api/sites/${site.id}/crons/${c.id}`, { schedule: c.schedule, command: c.command, note: c.note, enabled: !c.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const add = () => setEditing({ form: { schedule: '0 3 * * *', command: '', note: '', enabled: true } });
  return (
    <>
      <Card
        padded={false}
        icon={<Clock />}
        title="Tareas programadas (cron)"
        description="Comandos que se ejecutan solos con la frecuencia que elijas. Se guarda la salida de la última ejecución."
        actions={
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={add}>
            Nueva tarea
          </Button>
        }
      >
        {d.crons.length === 0 ? (
          <Empty
            icon={<CalendarClock className="size-6" />}
            title="Sin tareas programadas"
            description="Úsalas para el planificador de Laravel, el cron de WordPress, limpiezas, informes o sincronizaciones."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={add}>
                Crear tarea
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {d.crons.map((c) => (
              <li key={c.id} className={cx('px-4 py-3', !c.enabled && 'opacity-60')}>
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.note || describeCron(c.schedule)}</span>
                      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-muted">{c.schedule}</code>
                      {!c.enabled && <Badge>Pausada</Badge>}
                    </div>
                    <code className="mt-1 block truncate font-mono text-[12.5px]">$ {c.command}</code>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                      {c.last_run ? (
                        <button className="hover:text-fg" onClick={() => setOutput(c)}>
                          Última: {timeAgo(c.last_run)} ·{' '}
                          {c.last_status === 'running' ? (
                            <span className="text-info">ejecutándose…</span>
                          ) : (
                            <span className={c.last_status === 'failed' ? 'text-danger' : 'text-ok'}>
                              {c.last_status === 'failed' ? 'error' : 'correcta'} ({(c.last_duration / 1000).toFixed(1)} s)
                            </span>
                          )}{' '}
                          · ver salida
                        </button>
                      ) : (
                        <span>Aún no se ha ejecutado</span>
                      )}
                      {c.next[0] && <span>Próxima: {new Date(c.next[0]).toLocaleString('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
                    </div>
                  </div>
                  <div className="flex gap-0.5">
                    <Button size="sm" icon={<Play className="size-3.5" />} loading={runNow.isPending && runNow.variables === c.id} disabled={c.last_status === 'running'} onClick={() => runNow.mutate(c.id)}>
                      Ejecutar
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={c.enabled ? 'Pausar' : 'Activar'} title={c.enabled ? 'Pausar' : 'Activar'} onClick={() => toggle.mutate(c)}>
                      {c.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEditing({ form: { schedule: c.schedule, command: c.command, note: c.note, enabled: c.enabled }, id: c.id })}>
                      <Settings2 className="size-3.5" />
                    </Button>
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      aria-label="Eliminar"
                      title="Eliminar tarea"
                      message={<>Se dejará de ejecutar <code className="font-mono">{c.command}</code>.</>}
                      onConfirm={async () => {
                        await api.del(`/api/sites/${site.id}/crons/${c.id}`);
                        qc.invalidateQueries({ queryKey: key });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </ConfirmButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && <CronModal site={site} initial={editing.form} id={editing.id} presets={d.presets} onClose={() => setEditing(null)} />}
      <Modal open={!!output} onClose={() => setOutput(null)} wide title={<span className="flex items-center gap-2"><Terminal className="size-4" /> Salida de la última ejecución</span>}>
        {output && (
          <>
            <p className="mb-2 font-mono text-xs text-muted">$ {output.command}</p>
            <pre className="max-h-[55vh] overflow-auto rounded-lg bg-[#0b0d12] p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-[#cfd5e1]">
              {output.last_output.trim() || '(sin salida)'}
            </pre>
          </>
        )}
      </Modal>
    </>
  );
}

// --- PHP settings ----------------------------------------------------------------------------

interface PhpSettings {
  memory_limit_mb: number;
  upload_max_mb: number;
  max_execution_time: number;
  max_input_vars: number;
  display_errors: boolean;
  timezone: string;
}

const TIMEZONES = ['Europe/Madrid', 'Atlantic/Canary', 'Europe/Lisbon', 'Europe/London', 'Europe/Paris', 'America/Mexico_City', 'America/Bogota', 'America/Argentina/Buenos_Aires', 'America/Santiago', 'America/Lima', 'America/New_York', 'UTC'];

export function PhpSettingsCard({ site }: { site: Site }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['php-settings', site.id], queryFn: () => api.get<{ settings: PhpSettings; defaults: PhpSettings }>(`/api/sites/${site.id}/php-settings`) });
  const [f, setF] = useState<PhpSettings | null>(null);
  useEffect(() => {
    if (q.data && !f) setF(q.data.settings);
  }, [q.data, f]);
  const save = useMutation({
    mutationFn: () => api.put<{ deployment_id: number | null }>(`/api/sites/${site.id}/php-settings`, f),
    onSuccess: () => {
      toast.success('Ajustes de PHP aplicados');
      qc.invalidateQueries({ queryKey: ['php-settings', site.id] });
      qc.invalidateQueries({ queryKey: ['deployments', site.id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!f || !q.data) return <Spinner />;
  const set = <K extends keyof PhpSettings>(k: K, v: PhpSettings[K]) => setF({ ...f, [k]: v });
  const dirty = JSON.stringify(f) !== JSON.stringify(q.data.settings);
  const num = (k: 'memory_limit_mb' | 'upload_max_mb' | 'max_execution_time' | 'max_input_vars', options: number[], unit: string) => (
    <Select value={f[k]} onChange={(e) => set(k, Number(e.target.value))}>
      {[...new Set([...options, f[k]])].sort((a, b) => a - b).map((n) => (
        <option key={n} value={n}>
          {n.toLocaleString('es')} {unit}
          {n === q.data!.defaults[k] ? ' (por defecto)' : ''}
        </option>
      ))}
    </Select>
  );
  return (
    <Card title={`Ajustes de PHP ${site.php_effective ?? ''}`} description="Se aplican solo a este sitio, sin reiniciar los demás." icon={<Settings2 />}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Memoria máxima (memory_limit)" hint="Súbelo si ves «Allowed memory size exhausted».">
          {num('memory_limit_mb', [128, 256, 512, 768, 1024, 2048], 'MB')}
        </Field>
        <Field label="Tamaño máximo de subida" hint="upload_max_filesize y post_max_size. El WAF del dominio también limita el tamaño.">
          {num('upload_max_mb', [8, 32, 64, 128, 256, 512, 1024], 'MB')}
        </Field>
        <Field label="Tiempo máximo de ejecución" hint="max_execution_time por petición.">
          {num('max_execution_time', [30, 60, 120, 300, 600], 's')}
        </Field>
        <Field label="Variables de formulario (max_input_vars)" hint="Súbelo para menús o formularios muy grandes.">
          {num('max_input_vars', [1000, 3000, 5000, 10000, 20000], '')}
        </Field>
        <Field label="Zona horaria (date.timezone)">
          <Select value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
            {[...new Set([...TIMEZONES, f.timezone])].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-2 border-t border-border">
        <Toggle
          checked={f.display_errors}
          onChange={(v) => set('display_errors', v)}
          label="Mostrar errores en la página"
          description="Solo para depurar: los visitantes verían rutas y detalles internos. Los errores siempre se guardan en la pestaña «Errores PHP»."
        />
      </div>
      {f.display_errors && <Callout tone="warn" className="mb-2">Recuerda desactivarlo cuando termines de depurar.</Callout>}
      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" disabled={!dirty} onClick={() => setF(q.data!.settings)}>
          Descartar
        </Button>
        <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
          Aplicar
        </Button>
      </div>
    </Card>
  );
}
