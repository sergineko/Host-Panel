import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock, Cpu, Inbox, Plus, Route as RouteIcon, Zap } from 'lucide-react';
import { api, type Worker } from '../lib/api';
import { compact, timeAgo } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, cx } from '../components/ui';

interface Template {
  id: string;
  label: string;
  description: string;
}

export function WorkerStatus({ w }: { w: Pick<Worker, 'status' | 'enabled'> }) {
  if (!w.enabled) return <Badge dot>Desactivado</Badge>;
  if (w.status === 'running') return <Badge tone="ok" dot>Activo</Badge>;
  if (w.status === 'error') return <Badge tone="danger" dot>Error</Badge>;
  return <Badge dot>{w.status === 'stopped' ? 'Detenido' : 'Nuevo'}</Badge>;
}

export function CreateWorker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['worker-templates'], queryFn: () => api.get<Template[]>('/api/workers/templates'), enabled: open });
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('hello');
  const create = useMutation({
    mutationFn: () => api.post<Worker & { deploy: { ok: boolean; error?: string } }>('/api/workers', { name, template }),
    onSuccess: (w) => {
      qc.invalidateQueries({ queryKey: ['workers'] });
      if (w.deploy.ok) toast.success(`${w.name} desplegado`);
      else toast.error('El Worker se creó pero no arrancó');
      onClose();
      navigate(`/workers/${w.id}`);
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Crear un Worker"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={!name} loading={create.isPending} onClick={() => create.mutate()}>
            Crear y desplegar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {create.error && <ErrorBox error={create.error} />}
        <Field label="Nombre" hint="Será también su dirección: nombre.workers.tu-dominio">
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="mi-api" autoFocus />
        </Field>
        <div>
          <div className="mb-1.5 text-[13px] font-medium">Empezar desde</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {templates.data?.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplate(t.id)}
                className={cx('rounded-md border p-3 text-left transition-colors', template === t.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2')}
              >
                <div className="font-medium">{t.label}</div>
                <div className="mt-0.5 text-[12.5px] text-muted">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default function Workers() {
  const q = useQuery({ queryKey: ['workers'], queryFn: () => api.get<Worker[]>('/api/workers'), refetchInterval: 15_000 });
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Workers"
        description="Código JavaScript que se ejecuta en tu servidor ante cada petición, cron o mensaje de cola. Compatible con la API de Cloudflare Workers."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            Crear Worker
          </Button>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data!.length ? (
        <Card>
          <Empty
            icon={<Zap className="size-6" />}
            title="Todavía no hay Workers"
            description="Crea APIs, redirecciones, webhooks, tareas programadas o consumidores de colas sin montar un servidor."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
                Crear el primero
              </Button>
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {q.data!.map((w) => (
              <li key={w.id}>
                <Link to={`/workers/${w.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2/50">
                  <div className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
                    <Zap className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{w.name}</span>
                      <WorkerStatus w={w} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                      {w.url && <span className="font-mono">{w.url.replace('https://', '')}</span>}
                      {w.routes.length > 0 && (
                        <span className="flex items-center gap-1">
                          <RouteIcon className="size-3" />
                          {w.routes.length} ruta{w.routes.length === 1 ? '' : 's'}
                        </span>
                      )}
                      {w.crons.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock className="size-3" />
                          {w.crons.length} cron
                        </span>
                      )}
                      {w.consumes.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Inbox className="size-3" />
                          consume {w.consumes.map((c) => c.name).join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="tabular flex gap-6 text-right text-xs text-muted">
                    <div>
                      <div className="text-[15px] font-semibold text-fg">{compact(w.requests_24h ?? 0)}</div>
                      peticiones 24 h
                    </div>
                    <div>
                      <div className={cx('text-[15px] font-semibold', w.errors_24h ? 'text-danger' : 'text-fg')}>{compact(w.errors_24h ?? 0)}</div>
                      errores
                    </div>
                    <div className="hidden sm:block">
                      <div className="flex items-center justify-end gap-1 text-[15px] font-semibold text-fg">
                        <Cpu className="size-3.5 text-muted" />v{w.version}
                      </div>
                      {w.deployed_at ? timeAgo(w.deployed_at) : '—'}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <CreateWorker open={open} onClose={() => setOpen(false)} />
    </>
  );
}
