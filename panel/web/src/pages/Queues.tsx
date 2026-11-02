import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, Plus } from 'lucide-react';
import { api, type Queue } from '../lib/api';
import { compact } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Table, Td } from '../components/ui';

export default function Queues() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['queues'], queryFn: () => api.get<Queue[]>('/api/queues'), refetchInterval: 5000 });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<Queue>('/api/queues', { name }),
    onSuccess: (queue) => {
      qc.invalidateQueries({ queryKey: ['queues'] });
      setOpen(false);
      setName('');
      navigate(`/queues/${queue.id}`);
    },
  });
  return (
    <>
      <PageHeader
        title="Colas"
        description="Mensajes que se procesan en segundo plano, por lotes y con reintentos. Envíalos desde un Worker o por HTTP y consúmelos con otro Worker."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            Crear cola
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
            icon={<Inbox className="size-6" />}
            title="Sin colas"
            description="Úsalas para enviar emails, procesar pedidos o llamar a APIs lentas sin hacer esperar al usuario."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
                Crear cola
              </Button>
            }
          />
        </Card>
      ) : (
        <Card padded={false}>
          <Table head={['Cola', 'Pendientes', 'Productores', 'Consumidor', 'Enviados 24 h', 'Fallidos 24 h']}>
            {q.data!.map((x) => (
              <tr key={x.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => navigate(`/queues/${x.id}`)}>
                <Td>
                  <Link to={`/queues/${x.id}`} className="font-mono font-medium hover:text-accent" onClick={(e) => e.stopPropagation()}>
                    {x.name}
                  </Link>
                  {x.delivery_paused && <Badge tone="warn">Pausada</Badge>}
                </Td>
                <Td className="tabular">{compact(x.backlog.total)}</Td>
                <Td className="text-muted">{x.producers.length ? x.producers.map((p) => p.name).join(', ') : 'HTTP'}</Td>
                <Td>{x.consumer ? <span className="font-mono">{x.consumer.name}</span> : <Badge tone="warn">Sin consumidor</Badge>}</Td>
                <Td className="tabular">{compact(x.totals_24h.sent)}</Td>
                <Td className={x.totals_24h.dead ? 'tabular text-danger' : 'tabular text-muted'}>{compact(x.totals_24h.dead)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Crear cola"
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
        <Field label="Nombre" hint="Minúsculas, números y guiones.">
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="emails-pendientes" autoFocus />
        </Field>
      </Modal>
    </>
  );
}
