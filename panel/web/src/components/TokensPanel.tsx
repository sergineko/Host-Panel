import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { api, type ApiToken } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Badge, Button, Card, ConfirmButton, Copyable, ErrorBox, Field, Input, Modal, Select, Table, Td } from './ui';

/** API tokens of a bucket or database: list, create (shown once) and revoke. */
export function TokensPanel({ basePath, children }: { basePath: string; children?: ReactNode }) {
  const qc = useQueryClient();
  const key = ['tokens', basePath];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ApiToken[]>(`${basePath}/tokens`) });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [write, setWrite] = useState('1');
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>(`${basePath}/tokens`, { name, can_write: write === '1' }),
    onSuccess: (r) => {
      setOpen(false);
      setName('');
      setCreated(r.token);
      qc.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <div className="space-y-4">
      {children}
      <Card
        padded={false}
        title="Tokens de acceso"
        actions={
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setOpen(true)}>
            Nuevo token
          </Button>
        }
      >
        {!q.data?.length ? (
          <p className="p-6 text-center text-[13px] text-muted">Sin tokens. Crea uno para usar la API desde tus aplicaciones.</p>
        ) : (
          <Table head={['Nombre', 'Token', 'Permisos', 'Último uso', '']}>
            {q.data.map((t) => (
              <tr key={t.id}>
                <Td className="font-medium">{t.name}</Td>
                <Td className="font-mono text-xs text-muted">{t.prefix}…</Td>
                <Td>{t.can_write ? <Badge tone="warn">Lectura y escritura</Badge> : <Badge tone="info">Solo lectura</Badge>}</Td>
                <Td className="text-muted">{t.last_used ? timeAgo(t.last_used) : 'Nunca'}</Td>
                <Td className="w-10">
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    aria-label="Revocar token"
                    title={`Revocar "${t.name}"`}
                    message="Las aplicaciones que lo usen dejarán de tener acceso inmediatamente."
                    label="Revocar"
                    onConfirm={async () => {
                      await api.del(`${basePath}/tokens/${t.id}`);
                      qc.invalidateQueries({ queryKey: key });
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </ConfirmButton>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nuevo token"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancelar</Button>
            <Button variant="primary" disabled={!name} loading={create.isPending} onClick={() => create.mutate()}>
              Crear
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {create.error && <ErrorBox error={create.error} />}
          <Field label="Nombre" hint="Para reconocerlo después: la app o el entorno que lo usa.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="web-produccion" autoFocus />
          </Field>
          <Field label="Permisos">
            <Select value={write} onChange={(e) => setWrite(e.target.value)}>
              <option value="1">Lectura y escritura</option>
              <option value="0">Solo lectura</option>
            </Select>
          </Field>
        </div>
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title="Token creado" footer={<Button variant="primary" onClick={() => setCreated(null)}>Hecho</Button>}>
        <p className="mb-3 flex items-start gap-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          Cópialo ahora: por seguridad solo se guarda su huella y no se volverá a mostrar.
        </p>
        <Copyable value={created ?? ''} />
      </Modal>
    </div>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-[#0b0d12] p-3 font-mono text-[12px] leading-relaxed text-[#cfd5e1]">{children}</pre>
      <div className="absolute top-1.5 right-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="!text-[#8d95a5] hover:!bg-white/10"
          onClick={() => navigator.clipboard.writeText(children)}
        >
          Copiar
        </Button>
      </div>
    </div>
  );
}
