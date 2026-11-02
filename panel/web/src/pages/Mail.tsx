import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, KeyRound, Mail as MailIcon, Plus, Trash2, X } from 'lucide-react';
import { api, type Mailbox } from '../lib/api';
import { Button, Card, ConfirmButton, Copyable, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td } from '../components/ui';

interface MailData {
  domains: { id: number; name: string }[];
  mailboxes: Mailbox[];
  server: { hostname: string; webmail: string; imap: { host: string; port: number }; smtp: { host: string; port: number; alt: number } };
}

function Usage({ used, quota }: { used: number; quota: number }) {
  const pct = quota ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  return (
    <div className="w-32">
      <div className="tabular mb-1 text-xs text-muted">
        {used} / {quota ? `${quota} MB` : '∞'}
      </div>
      <div className="h-1 rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${pct > 90 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function Mail() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const domain = params.get('domain') ?? '';
  const q = useQuery({ queryKey: ['mail', domain], queryFn: () => api.get<MailData>(`/api/mail${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`) });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ local: '', domain: '', name: '', password: '', quotaMb: 2048 });
  const [created, setCreated] = useState<{ email: string; password?: string } | null>(null);
  const [aliasFor, setAliasFor] = useState<Mailbox | null>(null);
  const [alias, setAlias] = useState('');
  const [pwFor, setPwFor] = useState<Mailbox | null>(null);
  const [newPw, setNewPw] = useState('');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['mail'] });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ email: string; password?: string }>('/api/mail/mailboxes', {
        email: `${form.local}@${form.domain || q.data?.domains[0]?.name}`,
        name: form.name,
        password: form.password || undefined,
        quotaMb: form.quotaMb,
      }),
    onSuccess: (r) => {
      setCreating(false);
      setCreated(r);
      setForm({ ...form, local: '', name: '', password: '' });
      invalidate();
    },
  });
  const addAlias = useMutation({
    mutationFn: () => api.post(`/api/mail/mailboxes/${encodeURIComponent(aliasFor!.email)}/aliases`, { alias }),
    onSuccess: () => {
      toast.success('Alias añadido');
      setAliasFor(null);
      setAlias('');
      invalidate();
    },
  });
  const removeAlias = useMutation({
    mutationFn: ({ email, alias }: { email: string; alias: string }) => api.del(`/api/mail/mailboxes/${encodeURIComponent(email)}/aliases/${encodeURIComponent(alias)}`),
    onSuccess: invalidate,
  });
  const changePw = useMutation({
    mutationFn: () => api.put(`/api/mail/mailboxes/${encodeURIComponent(pwFor!.email)}`, { password: newPw }),
    onSuccess: () => {
      toast.success('Contraseña cambiada');
      setPwFor(null);
      setNewPw('');
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;

  return (
    <>
      <PageHeader
        title="Correo"
        description="Buzones IMAP/SMTP con antispam, DKIM, SPF y DMARC para todos tus dominios."
        actions={
          <>
            {d.server.webmail && (
              <a href={d.server.webmail} target="_blank" rel="noreferrer">
                <Button icon={<ExternalLink className="size-4" />}>Webmail</Button>
              </a>
            )}
            <Button variant="primary" icon={<Plus className="size-4" />} disabled={!d.domains.length} onClick={() => setCreating(true)}>
              Nuevo buzón
            </Button>
          </>
        }
      />

      {!d.domains.length ? (
        <Card>
          <Empty
            icon={<MailIcon className="size-6" />}
            title="Ningún dominio tiene el correo activado"
            description="Abre un dominio, pestaña Correo, y pulsa Activar. Los registros DNS se crean solos."
            action={
              <Link to="/domains">
                <Button variant="primary">Ir a dominios</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-surface p-3">
              <div className="text-xs text-muted">IMAP (entrada)</div>
              <div className="font-mono text-[13px]">{d.server.imap.host}:{d.server.imap.port} SSL</div>
            </div>
            <div className="rounded-lg border border-border bg-surface p-3">
              <div className="text-xs text-muted">SMTP (salida)</div>
              <div className="font-mono text-[13px]">{d.server.smtp.host}:{d.server.smtp.port} SSL · {d.server.smtp.alt} STARTTLS</div>
            </div>
            <div className="rounded-lg border border-border bg-surface p-3">
              <div className="text-xs text-muted">Usuario</div>
              <div className="text-[13px]">La dirección de correo completa</div>
            </div>
          </div>
          <Card
            padded={false}
            title={`Buzones (${d.mailboxes.length})`}
            actions={
              <Select className="!h-8 w-48" value={domain} onChange={(e) => setParams(e.target.value ? { domain: e.target.value } : {})}>
                <option value="">Todos los dominios</option>
                {d.domains.map((x) => (
                  <option key={x.id}>{x.name}</option>
                ))}
              </Select>
            }
          >
            {d.mailboxes.length === 0 ? (
              <Empty title="Sin buzones" />
            ) : (
              <Table head={['Dirección', 'Alias', 'Uso', '']}>
                {d.mailboxes.map((m) => (
                  <tr key={m.email} className="group">
                    <Td>
                      <div className="font-medium">{m.email}</div>
                      {m.name && <div className="text-xs text-muted">{m.name}</div>}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        {m.aliases.map((a) => (
                          <span key={a} className="inline-flex items-center gap-1 rounded bg-surface-2 py-0.5 pr-0.5 pl-1.5 text-xs">
                            {a}
                            <button aria-label={`Quitar ${a}`} className="rounded p-0.5 text-muted hover:text-danger" onClick={() => removeAlias.mutate({ email: m.email, alias: a })}>
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                        <button className="text-xs text-accent hover:underline" onClick={() => setAliasFor(m)}>
                          + alias
                        </button>
                      </div>
                    </Td>
                    <Td>
                      <Usage used={m.usedMb} quota={m.quotaMb} />
                    </Td>
                    <Td className="w-24">
                      <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                        <Button size="sm" variant="ghost" aria-label="Cambiar contraseña" onClick={() => setPwFor(m)}>
                          <KeyRound className="size-3.5" />
                        </Button>
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          aria-label="Eliminar buzón"
                          title={`Eliminar ${m.email}`}
                          message="Se borrarán todos los mensajes del buzón. No se puede deshacer."
                          onConfirm={async () => {
                            await api.del(`/api/mail/mailboxes/${encodeURIComponent(m.email)}`);
                            invalidate();
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
        </>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Nuevo buzón"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancelar</Button>
            <Button variant="primary" loading={create.isPending} disabled={!form.local} onClick={() => create.mutate()}>
              Crear
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {create.error && <ErrorBox error={create.error} />}
          <Field label="Dirección">
            <div className="flex items-center gap-1.5">
              <Input value={form.local} onChange={(e) => setForm({ ...form, local: e.target.value.trim().toLowerCase() })} placeholder="info" autoFocus />
              <span className="text-muted">@</span>
              <Select value={form.domain || d.domains[0]?.name} onChange={(e) => setForm({ ...form, domain: e.target.value })}>
                {d.domains.map((x) => (
                  <option key={x.id}>{x.name}</option>
                ))}
              </Select>
            </div>
          </Field>
          <Field label="Nombre visible">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Opcional" />
          </Field>
          <Field label="Contraseña" hint="Déjala vacía para generar una segura.">
            <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Field label="Cuota (MB)" hint="0 = sin límite">
            <Input type="number" min={0} value={form.quotaMb} onChange={(e) => setForm({ ...form, quotaMb: Number(e.target.value) })} />
          </Field>
        </div>
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title="Buzón creado" footer={<Button variant="primary" onClick={() => setCreated(null)}>Hecho</Button>}>
        <div className="space-y-3">
          <Field label="Usuario">
            <Copyable value={created?.email ?? ''} />
          </Field>
          {created?.password && (
            <Field label="Contraseña generada" hint="Cópiala ahora: no se volverá a mostrar.">
              <Copyable value={created.password} />
            </Field>
          )}
        </div>
      </Modal>

      <Modal
        open={!!aliasFor}
        onClose={() => setAliasFor(null)}
        title={`Alias para ${aliasFor?.email}`}
        footer={
          <Button variant="primary" loading={addAlias.isPending} onClick={() => addAlias.mutate()}>
            Añadir
          </Button>
        }
      >
        {addAlias.error && <ErrorBox error={addAlias.error} />}
        <Field label="Dirección alias" hint="El correo que llegue a esta dirección se entregará en el buzón.">
          <Input value={alias} onChange={(e) => setAlias(e.target.value.trim().toLowerCase())} placeholder={`ventas@${aliasFor?.email.split('@')[1] ?? ''}`} autoFocus />
        </Field>
      </Modal>

      <Modal
        open={!!pwFor}
        onClose={() => setPwFor(null)}
        title={`Contraseña de ${pwFor?.email}`}
        footer={
          <Button variant="primary" loading={changePw.isPending} onClick={() => changePw.mutate()}>
            Cambiar
          </Button>
        }
      >
        {changePw.error && <ErrorBox error={changePw.error} />}
        <Field label="Nueva contraseña" hint="Mínimo 10 caracteres.">
          <Input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </>
  );
}
