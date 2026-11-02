import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Lock, Package, Plus } from 'lucide-react';
import { api, type Bucket } from '../lib/api';
import { bytes, compact, timeAgo } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Toggle } from '../components/ui';

export default function Storage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['buckets'], queryFn: () => api.get<Bucket[]>('/api/buckets') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', public: false, hostname: '' });
  const create = useMutation({
    mutationFn: () => api.post<Bucket>('/api/buckets', form),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['buckets'] });
      setOpen(false);
      setForm({ name: '', public: false, hostname: '' });
      navigate(`/storage/${b.id}`);
    },
  });

  const total = (q.data ?? []).reduce((acc, b) => ({ size: acc.size + (b.usage?.size ?? 0), count: acc.count + (b.usage?.count ?? 0) }), { size: 0, count: 0 });

  return (
    <>
      <PageHeader
        title="Almacenamiento"
        description="Buckets de archivos al estilo R2: sube imágenes, vídeos o backups y sírvelos desde tu propio dominio o por API."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            Nuevo bucket
          </Button>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : q.data!.length === 0 ? (
        <Card>
          <Empty
            icon={<Package className="size-6" />}
            title="Sin buckets"
            description="Crea un bucket y conéctale un dominio (p. ej. cdn.tudominio.com) para servir archivos con caché y SSL."
            action={
              <Button icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
                Crear bucket
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex gap-6 text-[13px] text-muted">
            <span>
              <span className="tabular font-semibold text-fg">{bytes(total.size)}</span> ocupados
            </span>
            <span>
              <span className="tabular font-semibold text-fg">{compact(total.count)}</span> objetos
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {q.data!.map((b) => (
              <Link key={b.id} to={`/storage/${b.id}`} className="group rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-muted group-hover:text-accent">
                      <Package className="size-4" />
                    </div>
                    <span className="truncate font-mono font-semibold">{b.name}</span>
                  </div>
                  {b.public ? (
                    <Badge tone="info">
                      <Globe className="size-3" /> Público
                    </Badge>
                  ) : (
                    <Badge>
                      <Lock className="size-3" /> Privado
                    </Badge>
                  )}
                </div>
                <div className="mt-3 truncate font-mono text-xs text-muted">{b.hostname || (b.public ? 'Sin dominio propio' : 'Acceso por API con token')}</div>
                <div className="mt-3 flex justify-between border-t border-border pt-3 text-xs text-muted">
                  <span className="tabular">
                    {bytes(b.usage?.size ?? 0)} · {compact(b.usage?.count ?? 0)} objetos
                  </span>
                  <span>{timeAgo(b.created_at)}</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nuevo bucket"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancelar</Button>
            <Button variant="primary" loading={create.isPending} disabled={form.name.length < 3} onClick={() => create.mutate()}>
              Crear
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {create.error && <ErrorBox error={create.error} />}
          <Field label="Nombre" hint="3-63 caracteres: minúsculas, números y guiones. No se puede cambiar.">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="imagenes" autoFocus />
          </Field>
          <div className="border-y border-border">
            <Toggle checked={form.public} onChange={(v) => setForm({ ...form, public: v })} label="Acceso público" description="Cualquiera con la URL puede leer los archivos (ideal para imágenes y descargas). La escritura siempre requiere token." />
          </div>
          {form.public && (
            <Field label="Dominio propio (opcional)" hint="Crea un registro A o CNAME hacia este servidor. El SSL se emite solo.">
              <Input value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value.trim().toLowerCase() })} placeholder="cdn.midominio.com" />
            </Field>
          )}
        </div>
      </Modal>
    </>
  );
}
