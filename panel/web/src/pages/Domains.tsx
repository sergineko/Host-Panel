import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, Globe, Plus } from 'lucide-react';
import { api, type Domain } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Table, Td, Toggle } from '../components/ui';

export default function Domains() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['domains'], queryFn: () => api.get<Domain[]>('/api/domains') });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [dns, setDns] = useState(true);

  const create = useMutation({
    mutationFn: () => api.post<Domain>('/api/domains', { name, dns }),
    onSuccess: (d) => {
      toast.success(`Dominio ${d.name} añadido`);
      qc.invalidateQueries({ queryKey: ['domains'] });
      setOpen(false);
      setName('');
      navigate(`/domains/${d.id}`);
    },
  });

  return (
    <>
      <PageHeader
        title="Dominios y DNS"
        description="Cada dominio tiene su zona DNS, reglas de seguridad y, opcionalmente, correo."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            Añadir dominio
          </Button>
        }
      />
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-4">
            <ErrorBox error={q.error} />
          </div>
        ) : q.data!.length === 0 ? (
          <Empty
            icon={<Globe className="size-6" />}
            title="Sin dominios"
            description="Añade tu primer dominio y apunta sus nameservers a este servidor."
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                Añadir dominio
              </Button>
            }
          />
        ) : (
          <Table head={['Dominio', 'Servicios', 'Sitios', 'Añadido', '']}>
            {q.data!.map((d) => (
              <tr key={d.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => navigate(`/domains/${d.id}`)}>
                <Td>
                  <Link to={`/domains/${d.id}`} className="font-medium hover:text-accent">
                    {d.name}
                  </Link>
                </Td>
                <Td>
                  <div className="flex gap-1.5">
                    {d.dns_enabled ? <Badge tone="info">DNS</Badge> : <Badge>DNS externo</Badge>}
                    {d.mail_enabled ? <Badge tone="accent">Correo</Badge> : null}
                  </div>
                </Td>
                <Td className="tabular">{d.sites}</Td>
                <Td className="text-muted">{timeAgo(d.created_at)}</Td>
                <Td className="w-8 text-muted">
                  <ChevronRight className="size-4" />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Añadir dominio"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancelar</Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()} disabled={!name}>
              Añadir
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          {create.error && <ErrorBox error={create.error} />}
          <Field label="Dominio" hint="Sin www ni https://, por ejemplo midominio.com">
            <Input value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder="midominio.com" autoFocus />
          </Field>
          <Toggle
            checked={dns}
            onChange={setDns}
            label="Gestionar DNS en este servidor"
            description="Crea la zona con registros A, www, CAA. Desactívalo si el DNS está en otro proveedor (Cloudflare, registrador…)."
          />
        </form>
      </Modal>
    </>
  );
}
