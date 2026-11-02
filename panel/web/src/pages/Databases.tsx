import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { bytes, timeAgo } from '../lib/format';
import { Button, Card, ConfirmButton, Copyable, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Table, Td } from '../components/ui';

interface Db {
  id: number;
  name: string;
  username: string;
  note: string;
  size: number;
  created_at: string;
}
interface Credentials {
  name?: string;
  username: string;
  password: string;
  host?: string;
  port?: number;
}

export default function Databases() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['databases'], queryFn: () => api.get<Db[]>('/api/databases') });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [creds, setCreds] = useState<Credentials | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<Credentials>('/api/databases', { name, username: username || undefined }),
    onSuccess: (c) => {
      setOpen(false);
      setName('');
      setUsername('');
      setCreds(c);
      qc.invalidateQueries({ queryKey: ['databases'] });
    },
  });
  const reset = useMutation({
    mutationFn: (id: number) => api.post<Credentials>(`/api/databases/${id}/password`),
    onSuccess: (c) => {
      setCreds(c);
      qc.invalidateQueries({ queryKey: ['databases'] });
      qc.invalidateQueries({ queryKey: ['database'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Bases de datos"
        description="MariaDB con consola SQL, API HTTP al estilo D1, copias y acceso remoto. Cada base de datos tiene su propio usuario."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            Nueva base de datos
          </Button>
        }
      />
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-4"><ErrorBox error={q.error} /></div>
        ) : q.data!.length === 0 ? (
          <Empty icon={<Database className="size-6" />} title="Sin bases de datos" description="Crea una para WordPress, Laravel o tu aplicación." />
        ) : (
          <Table head={['Base de datos', 'Usuario', 'Tamaño', 'Creada', '']}>
            {q.data!.map((d) => (
              <tr key={d.id} className="group">
                <Td className="font-mono font-medium">
                  <Link to={`/databases/${d.id}`} className="hover:text-accent">
                    {d.name}
                  </Link>
                </Td>
                <Td className="font-mono text-muted">{d.username}</Td>
                <Td className="tabular">{bytes(d.size)}</Td>
                <Td className="text-muted">{timeAgo(d.created_at)}</Td>
                <Td className="w-24">
                  <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                    <Button size="sm" variant="ghost" aria-label="Nueva contraseña" loading={reset.isPending && reset.variables === d.id} onClick={() => reset.mutate(d.id)}>
                      <KeyRound className="size-3.5" />
                    </Button>
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      aria-label="Eliminar"
                      title={`Eliminar ${d.name}`}
                      message="Se borrarán la base de datos, todas sus tablas y su usuario. No se puede deshacer."
                      onConfirm={async () => {
                        await api.del(`/api/databases/${d.id}`);
                        qc.invalidateQueries({ queryKey: ['databases'] });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </ConfirmButton>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nueva base de datos"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancelar</Button>
            <Button variant="primary" loading={create.isPending} disabled={!name} onClick={() => create.mutate()}>
              Crear
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {create.error && <ErrorBox error={create.error} />}
          <Field label="Nombre" hint="Letras, números y guion bajo.">
            <Input value={name} onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} placeholder="mi_tienda" autoFocus />
          </Field>
          <Field label="Usuario" hint="Por defecto, el mismo nombre.">
            <Input value={username} onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} placeholder={name || 'usuario'} />
          </Field>
        </div>
      </Modal>

      <Modal open={!!creds} onClose={() => setCreds(null)} title="Credenciales" footer={<Button variant="primary" onClick={() => setCreds(null)}>Hecho</Button>}>
        <p className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">Guarda la contraseña ahora: no se volverá a mostrar.</p>
        <div className="space-y-3">
          {creds?.name && (
            <Field label="Base de datos">
              <Copyable value={creds.name} />
            </Field>
          )}
          <Field label="Usuario">
            <Copyable value={creds?.username ?? ''} />
          </Field>
          <Field label="Contraseña">
            <Copyable value={creds?.password ?? ''} />
          </Field>
          <Field label="Servidor">
            <Copyable value="localhost:3306" />
          </Field>
        </div>
      </Modal>
    </>
  );
}
