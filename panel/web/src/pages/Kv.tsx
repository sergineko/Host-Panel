import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, KeySquare, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api, type KvNamespace } from '../lib/api';
import { bytes, compact, timeAgo } from '../lib/format';
import { Badge, Button, Card, ConfirmButton, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Table, Td, Textarea } from '../components/ui';

export function KvList() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['kv'], queryFn: () => api.get<KvNamespace[]>('/api/kv') });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<KvNamespace>('/api/kv', { name }),
    onSuccess: (ns) => {
      qc.invalidateQueries({ queryKey: ['kv'] });
      setOpen(false);
      setName('');
      navigate(`/kv/${ns.id}`);
    },
  });
  return (
    <>
      <PageHeader
        title="KV"
        description="Almacén clave-valor para Workers: configuración, sesiones, cachés o contadores, con caducidad opcional."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            Crear espacio
          </Button>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data!.length ? (
        <Card>
          <Empty icon={<KeySquare className="size-6" />} title="Sin espacios KV" description="Crea uno y conéctalo a un Worker con un binding." />
        </Card>
      ) : (
        <Card padded={false}>
          <Table head={['Espacio', 'Claves', 'Tamaño', 'Workers', 'Creado']}>
            {q.data!.map((ns) => (
              <tr key={ns.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => navigate(`/kv/${ns.id}`)}>
                <Td className="font-mono font-medium">{ns.name}</Td>
                <Td className="tabular">{compact(ns.keys)}</Td>
                <Td className="tabular">{bytes(ns.size)}</Td>
                <Td className="text-muted">{ns.workers.map((w) => w.name).join(', ') || '—'}</Td>
                <Td className="text-muted">{timeAgo(ns.created_at)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Crear espacio KV"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancelar</Button>
            <Button variant="primary" disabled={!name} loading={create.isPending} onClick={() => create.mutate()}>
              Crear
            </Button>
          </>
        }
      >
        {create.error && <ErrorBox error={create.error} />}
        <Field label="Nombre">
          <Input value={name} onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, ''))} placeholder="SESIONES" autoFocus />
        </Field>
      </Modal>
    </>
  );
}

interface KeyList {
  keys: { name: string; expiration?: number; metadata?: unknown; size: number; updated_at: number }[];
  list_complete: boolean;
  cursor?: string;
}
interface KvValue {
  key: string;
  value: string;
  encoding: 'utf8' | 'base64';
  size: number;
  metadata: unknown;
  expiration: number | null;
}

function EditEntry({ nsId, entry, onClose }: { nsId: number; entry: { key: string; value: string; ttl: string } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(entry ?? { key: '', value: '', ttl: '' });
  const isNew = !entry?.key;
  const save = useMutation({
    mutationFn: () => api.put(`/api/kv/${nsId}/value`, { key: form.key, value: form.value, ttl: form.ttl ? Number(form.ttl) : undefined }),
    onSuccess: () => {
      toast.success('Guardado');
      qc.invalidateQueries({ queryKey: ['kv-keys', nsId] });
      qc.invalidateQueries({ queryKey: ['kv'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={isNew ? 'Nueva clave' : form.key}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={!form.key} loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {save.error && <ErrorBox error={save.error} />}
        {isNew && (
          <Field label="Clave">
            <Input className="font-mono" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="config:tema" autoFocus />
          </Field>
        )}
        <Field label="Valor">
          <Textarea className="min-h-48" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        </Field>
        <Field label="Caducidad en segundos (opcional)" hint="Mínimo 60. Vacío = no caduca.">
          <Input type="number" min={60} value={form.ttl} onChange={(e) => setForm({ ...form, ttl: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

export function KvDetail() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [prefix, setPrefix] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [editing, setEditing] = useState<{ key: string; value: string; ttl: string } | null | false>(false);
  const ns = useQuery({ queryKey: ['kv', id], queryFn: () => api.get<KvNamespace>(`/api/kv/${id}`) });
  const cursor = cursors.at(-1);
  const keys = useQuery({
    queryKey: ['kv-keys', id, prefix, cursor],
    queryFn: () => api.get<KeyList>(`/api/kv/${id}/keys?limit=50&prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${cursor}` : ''}`),
  });
  const remove = useMutation({
    mutationFn: (key: string) => api.del(`/api/kv/${id}/value?key=${encodeURIComponent(key)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kv-keys', id] }),
  });
  const open = async (key: string) => {
    const v = await api.get<KvValue>(`/api/kv/${id}/value?key=${encodeURIComponent(key)}`);
    if (v.encoding === 'base64') {
      toast.info('Valor binario: solo se puede sobrescribir');
      setEditing({ key, value: '', ttl: '' });
    } else setEditing({ key, value: v.value, ttl: '' });
  };
  if (ns.isLoading) return <Spinner />;
  if (ns.error) return <ErrorBox error={ns.error} />;
  return (
    <>
      <Link to="/kv" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> KV
      </Link>
      <PageHeader
        title={<span className="font-mono">{ns.data!.name}</span>}
        description={
          <span>
            {compact(ns.data!.keys)} claves · {bytes(ns.data!.size)}
            {ns.data!.workers.length > 0 && <> · usado por {ns.data!.workers.map((w) => w.name).join(', ')}</>}
          </span>
        }
        actions={
          <>
            <ConfirmButton
              variant="danger"
              icon={<Trash2 className="size-4" />}
              title={`Eliminar ${ns.data!.name}`}
              message="Se borrarán todas sus claves."
              onConfirm={async () => {
                await api.del(`/api/kv/${id}`);
                qc.invalidateQueries({ queryKey: ['kv'] });
                navigate('/kv');
              }}
            >
              Eliminar
            </ConfirmButton>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>
              Añadir clave
            </Button>
          </>
        }
      />
      <Card padded={false}>
        <div className="border-b border-border p-3">
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" />
            <Input
              className="pl-8 font-mono"
              placeholder="Buscar por prefijo…"
              value={prefix}
              onChange={(e) => {
                setPrefix(e.target.value);
                setCursors([undefined]);
              }}
            />
          </div>
        </div>
        {keys.isLoading ? (
          <Spinner />
        ) : !keys.data?.keys.length ? (
          <Empty title={prefix ? 'Ninguna clave con ese prefijo' : 'Sin claves'} />
        ) : (
          <Table head={['Clave', 'Tamaño', 'Caduca', 'Modificada', '']}>
            {keys.data.keys.map((k) => (
              <tr key={k.name} className="group">
                <Td>
                  <button className="font-mono text-[13px] hover:text-accent" onClick={() => open(k.name)}>
                    {k.name}
                  </button>
                  {k.metadata !== undefined && <Badge>metadatos</Badge>}
                </Td>
                <Td className="tabular">{bytes(k.size)}</Td>
                <Td className="text-xs text-muted">{k.expiration ? new Date(k.expiration * 1000).toLocaleString('es') : 'Nunca'}</Td>
                <Td className="text-xs text-muted">{timeAgo(Math.floor(k.updated_at / 1000))}</Td>
                <Td className="w-20">
                  <div className="flex justify-end opacity-60 group-hover:opacity-100">
                    <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => open(k.name)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Borrar" onClick={() => remove.mutate(k.name)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
          <Button size="sm" disabled={cursors.length < 2} onClick={() => setCursors(cursors.slice(0, -1))}>
            Anterior
          </Button>
          <Button size="sm" disabled={!keys.data || keys.data.list_complete} onClick={() => setCursors([...cursors, keys.data!.cursor])}>
            Siguiente
          </Button>
        </div>
      </Card>
      {editing !== false && <EditEntry nsId={id} entry={editing} onClose={() => setEditing(false)} />}
    </>
  );
}
