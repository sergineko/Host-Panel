import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Mail, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, type DnsRecord, type Domain } from '../lib/api';
import { Badge, Button, Card, ConfirmButton, Copyable, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Tabs, Td } from '../components/ui';
import { SecurityPanel } from '../components/SecurityPanel';

interface DomainDetailData extends Omit<Domain, 'sites'> {
  nameservers: string[];
  serverIp: string;
  mailHostname: string;
  sites: { id: number; name: string; type: string; status: string; hostnames: string }[];
}

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'];
const placeholders: Record<string, string> = {
  A: '203.0.113.10',
  AAAA: '2001:db8::1',
  CNAME: 'destino.ejemplo.com',
  MX: '10 mail.ejemplo.com',
  TXT: 'v=spf1 mx -all',
  SRV: '10 5 443 servicio.ejemplo.com',
  CAA: '0 issue "letsencrypt.org"',
  NS: 'ns1.ejemplo.com',
};
const typeTone: Record<string, 'info' | 'accent' | 'ok' | 'warn' | 'neutral'> = { A: 'info', AAAA: 'info', CNAME: 'ok', MX: 'accent', TXT: 'warn' };

type RecordForm = { name: string; type: string; ttl: number; content: string };
const emptyRecord: RecordForm = { name: '@', type: 'A', ttl: 3600, content: '' };

function RecordModal({ open, onClose, initial, onSave, saving, error }: { open: boolean; onClose: () => void; initial: RecordForm; onSave: (r: RecordForm) => void; saving: boolean; error: unknown }) {
  const [r, setR] = useState(initial);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial.content ? 'Editar registro' : 'Añadir registro'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={saving} disabled={!r.content} onClick={() => onSave(r)}>
            Guardar
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(r);
        }}
      >
        {error != null && (
          <div className="col-span-2">
            <ErrorBox error={error} />
          </div>
        )}
        <Field label="Tipo">
          <Select value={r.type} onChange={(e) => setR({ ...r, type: e.target.value })}>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label="TTL (segundos)">
          <Input type="number" min={60} value={r.ttl} onChange={(e) => setR({ ...r, ttl: Number(e.target.value) })} />
        </Field>
        <Field label="Nombre" hint="@ para el dominio raíz, * para comodín" className="col-span-2">
          <Input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="@" />
        </Field>
        <Field label="Contenido" className="col-span-2">
          <Input value={r.content} onChange={(e) => setR({ ...r, content: e.target.value })} placeholder={placeholders[r.type]} className="font-mono text-[13px]" autoFocus />
        </Field>
      </form>
    </Modal>
  );
}

function DnsTab({ domain }: { domain: DomainDetailData }) {
  const qc = useQueryClient();
  const key = ['dns', domain.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<DnsRecord[]>(`/api/domains/${domain.id}/dns`), enabled: !!domain.dns_enabled });
  const [editing, setEditing] = useState<{ old?: DnsRecord; form: RecordForm } | null>(null);
  const [filter, setFilter] = useState('');

  const save = useMutation({
    mutationFn: (r: RecordForm) =>
      editing?.old ? api.put<DnsRecord[]>(`/api/domains/${domain.id}/dns`, { old: editing.old, record: r }) : api.post<DnsRecord[]>(`/api/domains/${domain.id}/dns`, r),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      setEditing(null);
      toast.success('Registro guardado');
    },
  });
  const remove = useMutation({
    mutationFn: (r: DnsRecord) => api.post<DnsRecord[]>(`/api/domains/${domain.id}/dns/delete`, r),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      toast.success('Registro eliminado');
    },
    onError: (e) => toast.error(e.message),
  });

  if (!domain.dns_enabled) {
    return (
      <Card>
        <Empty title="DNS gestionado fuera de este servidor" description={`Crea en tu proveedor DNS un registro A de ${domain.name} apuntando a ${domain.serverIp}.`} />
      </Card>
    );
  }

  const records = (q.data ?? []).filter((r) => !filter || `${r.name} ${r.type} ${r.content}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-4">
      <Card title="Nameservers">
        <p className="mb-3 text-[13px] text-muted">En tu registrador de dominios, cambia los nameservers de {domain.name} por estos:</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {domain.nameservers.map((ns) => (
            <Copyable key={ns} value={ns} />
          ))}
        </div>
      </Card>
      <Card
        title="Registros DNS"
        padded={false}
        actions={
          <>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar…" className="!h-8 w-40" />
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ form: emptyRecord })}>
              Añadir
            </Button>
          </>
        }
      >
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-4">
            <ErrorBox error={q.error} />
          </div>
        ) : (
          <Table head={['Tipo', 'Nombre', 'Contenido', 'TTL', '']}>
            {records.map((r) => (
              <tr key={`${r.name}-${r.type}-${r.content}`} className="group">
                <Td className="w-20">
                  <Badge tone={typeTone[r.type] ?? 'neutral'}>{r.type}</Badge>
                </Td>
                <Td className="font-medium">{r.name}</Td>
                <Td className="max-w-md">
                  <code className="block truncate font-mono text-[12.5px] text-muted" title={r.content}>
                    {r.content}
                  </code>
                </Td>
                <Td className="tabular text-muted">{r.ttl}</Td>
                <Td className="w-20">
                  {r.type !== 'SOA' && (
                    <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                      <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEditing({ old: r, form: { name: r.name, type: r.type, ttl: r.ttl, content: r.content } })}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" aria-label="Eliminar" onClick={() => remove.mutate(r)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && (
        <RecordModal
          key={JSON.stringify(editing.form)}
          open
          onClose={() => {
            setEditing(null);
            save.reset();
          }}
          initial={editing.form}
          onSave={(r) => save.mutate(r)}
          saving={save.isPending}
          error={save.error}
        />
      )}
    </div>
  );
}

function MailTab({ domain }: { domain: DomainDetailData }) {
  const qc = useQueryClient();
  const enable = useMutation({
    mutationFn: () => api.post(`/api/domains/${domain.id}/mail`),
    onSuccess: () => {
      toast.success('Correo activado y registros DNS publicados');
      qc.invalidateQueries({ queryKey: ['domain', domain.id] });
      qc.invalidateQueries({ queryKey: ['dns', domain.id] });
    },
    onError: (e) => toast.error(e.message),
  });
  const republish = useMutation({
    mutationFn: () => api.post(`/api/domains/${domain.id}/mail/dns`),
    onSuccess: () => {
      toast.success('Registros de correo publicados');
      qc.invalidateQueries({ queryKey: ['dns', domain.id] });
    },
    onError: (e) => toast.error(e.message),
  });
  const records = useQuery({
    queryKey: ['mail-records', domain.id],
    queryFn: () => api.get<{ type: string; name: string; content: string }[]>(`/api/domains/${domain.id}/mail/records`),
    enabled: !!domain.mail_enabled,
  });

  if (!domain.mail_enabled) {
    return (
      <Card>
        <Empty
          icon={<Mail className="size-6" />}
          title="Correo desactivado"
          description="Al activarlo se crea la clave DKIM y se publican automáticamente los registros MX, SPF, DKIM y DMARC."
          action={
            <Button variant="primary" loading={enable.isPending} onClick={() => enable.mutate()}>
              Activar correo para {domain.name}
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card
        title="Correo activo"
        actions={
          <>
            <Link to={`/mail?domain=${domain.name}`}>
              <Button size="sm" variant="primary">
                Gestionar buzones
              </Button>
            </Link>
            <ConfirmButton
              size="sm"
              variant="danger"
              title="Desactivar correo"
              message={`Se eliminarán todos los buzones de ${domain.name} y su contenido. No se puede deshacer.`}
              label="Desactivar y borrar"
              onConfirm={async () => {
                await api.del(`/api/domains/${domain.id}/mail`);
                qc.invalidateQueries({ queryKey: ['domain', domain.id] });
              }}
            >
              Desactivar
            </ConfirmButton>
          </>
        }
      >
        <p className="text-[13px] text-muted">
          Servidor: <span className="font-mono text-fg">{domain.mailHostname}</span> · IMAP 993 (SSL) · SMTP 465 (SSL) / 587 (STARTTLS)
        </p>
      </Card>
      <Card
        title="Registros DNS de correo"
        padded={false}
        actions={
          domain.dns_enabled ? (
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={republish.isPending} onClick={() => republish.mutate()}>
              Volver a publicar
            </Button>
          ) : null
        }
      >
        {!domain.dns_enabled && <p className="px-4 pt-3 text-[13px] text-warn">Tu DNS es externo: crea estos registros manualmente en tu proveedor.</p>}
        {records.isLoading ? (
          <Spinner />
        ) : records.error ? (
          <div className="p-4">
            <ErrorBox error={records.error} />
          </div>
        ) : (
          <Table head={['Tipo', 'Nombre', 'Valor']}>
            {records.data!.map((r, i) => (
              <tr key={i}>
                <Td className="w-20">
                  <Badge tone={typeTone[r.type] ?? 'neutral'}>{r.type}</Badge>
                </Td>
                <Td className="font-mono text-[12.5px]">{r.name}</Td>
                <Td className="max-w-md">
                  <Copyable value={r.content} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

export default function DomainDetail() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'dns') as 'dns' | 'security' | 'mail' | 'sites';
  const q = useQuery({ queryKey: ['domain', id], queryFn: () => api.get<DomainDetailData>(`/api/domains/${id}`) });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;

  return (
    <>
      <Link to="/domains" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Dominios
      </Link>
      <PageHeader
        title={d.name}
        actions={
          <ConfirmButton
            variant="danger"
            title={`Eliminar ${d.name}`}
            message="Se borrará la zona DNS, el correo, las reglas de seguridad y las rutas de proxy de este dominio."
            onConfirm={async () => {
              await api.del(`/api/domains/${id}`);
              qc.invalidateQueries({ queryKey: ['domains'] });
              toast.success('Dominio eliminado');
              navigate('/domains');
            }}
            icon={<Trash2 className="size-4" />}
          >
            Eliminar
          </ConfirmButton>
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { id: 'dns', label: 'DNS' },
          { id: 'security', label: 'Seguridad' },
          { id: 'mail', label: 'Correo' },
          { id: 'sites', label: `Sitios (${d.sites.length})` },
        ]}
      />
      {tab === 'dns' && <DnsTab domain={d} />}
      {tab === 'security' && <SecurityPanel domainId={id} />}
      {tab === 'mail' && <MailTab domain={d} />}
      {tab === 'sites' && (
        <Card padded={false}>
          {d.sites.length === 0 ? (
            <Empty
              title="Ningún sitio usa este dominio"
              action={
                <Link to={`/sites/new?host=${d.name}`}>
                  <Button variant="primary">Crear sitio para {d.name}</Button>
                </Link>
              }
            />
          ) : (
            <Table head={['Sitio', 'Hostnames', 'Tipo']}>
              {d.sites.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <Link className="font-medium hover:text-accent" to={`/sites/${s.id}`}>
                      {s.name}
                    </Link>
                  </Td>
                  <Td className="text-muted">{(JSON.parse(s.hostnames) as string[]).join(', ')}</Td>
                  <Td>
                    <Badge>{s.type}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
