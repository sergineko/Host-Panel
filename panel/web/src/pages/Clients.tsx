import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Plus, ShieldOff, UserPlus, Users } from 'lucide-react';
import { api, type ClientAccount, type ClientDetail, type DatabaseInfo, type Domain, type PanelUser } from '../lib/api';
import { timeAgo } from '../lib/format';
import { ROLE_LABEL, useMe } from '../lib/me';
import { AccessUsage, useLicense } from '../components/LicenseCards';
import { Badge, Button, Callout, Card, ConfirmButton, Copyable, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Table, Tabs, Td, Textarea, cx } from '../components/ui';

type ClientForm = { name: string; email: string; company: string; notes: string };
const emptyForm: ClientForm = { name: '', email: '', company: '', notes: '' };

/** A password that is shown once (new login or reset). */
function OneTimePassword({ value, onClose }: { value: { username: string; password: string } | null; onClose: () => void }) {
  return (
    <Modal
      open={!!value}
      onClose={onClose}
      title="Contraseña de acceso"
      footer={
        <Button variant="primary" onClick={onClose}>
          Hecho
        </Button>
      }
    >
      {value && (
        <div className="space-y-3 text-[13px]">
          <p className="text-muted">Pásale estos datos por un canal seguro. La contraseña no se volverá a mostrar; podrá cambiarla en Ajustes.</p>
          <Field label="Usuario">
            <Copyable value={value.username} />
          </Field>
          <Field label="Contraseña">
            <Copyable value={value.password} />
          </Field>
          <Field label="Dirección del panel">
            <Copyable value={location.origin} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/** Row actions shared by client logins and team members. */
function UserActions({ user, onPassword, invalidate }: { user: PanelUser; onPassword: (v: { username: string; password: string }) => void; invalidate: () => void }) {
  const reset = useMutation({ mutationFn: () => api.post<{ username: string; password: string }>(`/api/users/${user.id}/password`), onSuccess: onPassword });
  const toggle = useMutation({
    mutationFn: () => api.put(`/api/users/${user.id}`, { disabled: !user.disabled }),
    onSuccess: () => {
      toast.success(user.disabled ? 'Acceso reactivado' : 'Acceso desactivado');
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reset2fa = useMutation({
    mutationFn: () => api.post(`/api/users/${user.id}/2fa/reset`),
    onSuccess: () => {
      toast.success('Verificación en dos pasos quitada');
      invalidate();
    },
  });
  const remove = useMutation({ mutationFn: () => api.del(`/api/users/${user.id}`), onSuccess: invalidate, onError: (e) => toast.error((e as Error).message) });
  return (
    <div className="flex justify-end gap-1 whitespace-nowrap">
      <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} loading={reset.isPending} onClick={() => reset.mutate()}>
        Nueva contraseña
      </Button>
      {user.totp && (
        <Button size="sm" variant="ghost" icon={<ShieldOff className="size-3.5" />} loading={reset2fa.isPending} onClick={() => reset2fa.mutate()}>
          Quitar 2FA
        </Button>
      )}
      <Button size="sm" variant="ghost" loading={toggle.isPending} onClick={() => toggle.mutate()}>
        {user.disabled ? 'Activar' : 'Desactivar'}
      </Button>
      <ConfirmButton size="sm" variant="ghost" title={`Eliminar ${user.username}`} message="Perderá el acceso al panel. Sus dominios y datos no se tocan." onConfirm={() => remove.mutateAsync()}>
        Eliminar
      </ConfirmButton>
    </div>
  );
}

function UsersTable({ users, onPassword, invalidate, showClient }: { users: PanelUser[]; onPassword: (v: { username: string; password: string }) => void; invalidate: () => void; showClient?: boolean }) {
  if (!users.length) return <p className="px-4 py-6 text-center text-[13px] text-muted">Todavía no hay usuarios.</p>;
  return (
    <Table head={['Usuario', ...(showClient ? ['Rol'] : []), 'Último acceso', '']}>
      {users.map((u) => (
        <tr key={u.id}>
          <Td>
            <div className="flex flex-wrap items-center gap-1.5 font-medium">
              {u.username}
              {u.disabled && <Badge tone="danger">Desactivado</Badge>}
              {u.totp && <Badge tone="ok">2FA</Badge>}
            </div>
            {u.email && <div className="text-xs text-muted">{u.email}</div>}
          </Td>
          {showClient && <Td><Badge>{ROLE_LABEL[u.role]}</Badge></Td>}
          <Td className="text-xs whitespace-nowrap text-muted">{u.last_login_at ? timeAgo(u.last_login_at) : 'Nunca'}</Td>
          <Td className="text-right">{u.role !== 'owner' && <UserActions user={u} onPassword={onPassword} invalidate={invalidate} />}</Td>
        </tr>
      ))}
    </Table>
  );
}

function AddUser({ role, clientId, onCreated }: { role: 'admin' | 'client'; clientId?: number; onCreated: (v: { username: string; password: string }) => void }) {
  const qc = useQueryClient();
  const lic = useLicense();
  const full = !!lic.data && lic.data.max !== null && lic.data.used >= lic.data.max;
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const add = useMutation({
    mutationFn: () => api.post<{ user: PanelUser; password?: string }>('/api/users', { username, email, role, client_id: clientId }),
    onSuccess: (r) => {
      setUsername('');
      setEmail('');
      qc.invalidateQueries({ queryKey: ['license'] });
      if (r.password) onCreated({ username: r.user.username, password: r.password });
    },
  });
  if (full) {
    return (
      <div className="border-t border-border p-4">
        <Callout tone="warn" title={`Has llegado al límite de tu plan ${lic.data!.plan.name}`}>
          Tu plan incluye {lic.data!.max} {lic.data!.max === 1 ? 'acceso' : 'accesos'} (titular, equipo y clientes). Desactiva alguno o cambia de plan en Ajustes → Licencia.
        </Callout>
      </div>
    );
  }
  return (
    <form
      className="space-y-2 border-t border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Nombre de usuario" className="min-w-40 flex-1">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={role === 'admin' ? 'p. ej. soporte.ana' : 'p. ej. lucia.tienda'} autoCapitalize="none" spellCheck={false} />
        </Field>
        <Field label="Email (opcional)" className="min-w-40 flex-1">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" icon={<UserPlus className="size-4" />} loading={add.isPending} disabled={!username}>
          Añadir
        </Button>
      </div>
      {add.error && <ErrorBox error={add.error} />}
      <p className="text-xs text-muted">Se genera una contraseña segura que verás una sola vez.</p>
    </form>
  );
}

// --- one client ---------------------------------------------------------------------------------

function ClientModal({ clientId, onClose }: { clientId: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'info' | 'resources' | 'users'>('info');
  const [form, setForm] = useState<ClientForm & { status: 'active' | 'suspended' }>({ ...emptyForm, status: 'active' });
  const [domainIds, setDomainIds] = useState<Set<number>>(new Set());
  const [dbIds, setDbIds] = useState<Set<number>>(new Set());
  const [shown, setShown] = useState<{ username: string; password: string } | null>(null);
  const q = useQuery({ queryKey: ['client', clientId], queryFn: () => api.get<ClientDetail>(`/api/clients/${clientId}`), enabled: clientId !== null });
  const domains = useQuery({ queryKey: ['domains'], queryFn: () => api.get<Domain[]>('/api/domains'), enabled: clientId !== null && tab === 'resources' });
  const dbs = useQuery({ queryKey: ['databases'], queryFn: () => api.get<DatabaseInfo[]>('/api/databases'), enabled: clientId !== null && tab === 'resources' });

  useEffect(() => {
    if (!q.data) return;
    setForm({ name: q.data.name, email: q.data.email, company: q.data.company, notes: q.data.notes, status: q.data.status });
    setDomainIds(new Set(q.data.domains.map((d) => d.id)));
    setDbIds(new Set(q.data.databases.map((d) => d.id)));
  }, [q.data]);
  useEffect(() => setTab('info'), [clientId]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['client', clientId] });
    qc.invalidateQueries({ queryKey: ['clients'] });
    qc.invalidateQueries({ queryKey: ['domains'] });
    qc.invalidateQueries({ queryKey: ['databases'] });
    qc.invalidateQueries({ queryKey: ['license'] });
  };
  const save = useMutation({
    mutationFn: () => api.put(`/api/clients/${clientId}`, form),
    onSuccess: () => {
      toast.success('Cliente guardado');
      invalidate();
    },
  });
  const saveResources = useMutation({
    mutationFn: () => api.put(`/api/clients/${clientId}/resources`, { domain_ids: [...domainIds], database_ids: [...dbIds] }),
    onSuccess: () => {
      toast.success('Dominios y bases de datos asignados');
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/clients/${clientId}`),
    onSuccess: () => {
      toast.success('Cliente eliminado');
      invalidate();
      onClose();
    },
  });
  const toggleIn = (set: Set<number>, id: number, setter: (s: Set<number>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  return (
    <Modal open={clientId !== null} onClose={onClose} title={q.data?.name ?? 'Cliente'} wide>
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data ? (
        <Spinner />
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'info', label: 'Datos' },
              { id: 'resources', label: `Dominios y BD (${q.data!.domains.length + q.data!.databases.length})` },
              { id: 'users', label: `Accesos (${q.data!.users.length})` },
            ]}
          />
          {tab === 'info' && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nombre">
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label="Empresa">
                  <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
                </Field>
              </div>
              <Field label="Email de contacto">
                <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label="Notas internas" hint="Solo las ve tu equipo.">
                <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="min-h-20" />
              </Field>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="text-[13px]">
                  <div className="font-medium">{form.status === 'active' ? 'Cuenta activa' : 'Cuenta suspendida'}</div>
                  <div className="text-muted">
                    {form.status === 'active' ? 'Sus usuarios pueden entrar al panel. Cuenta como cliente activo de tu licencia.' : 'Nadie de esta cuenta puede entrar al panel. Sus webs y correo siguen funcionando.'}
                  </div>
                </div>
                <Button type="button" variant={form.status === 'active' ? 'danger' : 'secondary'} onClick={() => setForm({ ...form, status: form.status === 'active' ? 'suspended' : 'active' })}>
                  {form.status === 'active' ? 'Suspender' : 'Reactivar'}
                </Button>
              </div>
              {save.error && <ErrorBox error={save.error} />}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <ConfirmButton
                  variant="danger"
                  title={`Eliminar ${q.data!.name}`}
                  message="Se borran la cuenta y sus accesos. Sus dominios, webs, correo y bases de datos NO se borran: vuelven a ser tuyos."
                  onConfirm={() => remove.mutateAsync()}
                >
                  Eliminar cliente
                </ConfirmButton>
                <Button type="submit" variant="primary" loading={save.isPending} disabled={!form.name.trim()}>
                  Guardar
                </Button>
              </div>
            </form>
          )}

          {tab === 'resources' && (
            <div className="space-y-4">
              <p className="text-[13px] text-muted">
                El cliente gestiona sus dominios con todo lo que cuelga de ellos: DNS, correo, seguridad, sitios web, archivos y copias. No puede añadir ni borrar dominios.
              </p>
              {domains.isLoading || dbs.isLoading ? (
                <Spinner />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ['Dominios', domains.data ?? [], domainIds, setDomainIds],
                      ['Bases de datos', dbs.data ?? [], dbIds, setDbIds],
                    ] as const
                  ).map(([label, rows, set, setter]) => (
                    <div key={label}>
                      <div className="mb-1.5 text-[13px] font-medium">{label}</div>
                      <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                        {rows.length === 0 && <p className="p-3 text-[13px] text-muted">No hay ninguno.</p>}
                        {rows.map((r: Domain | DatabaseInfo) => {
                          const other = r.client_id != null && r.client_id !== clientId;
                          return (
                            <label key={r.id} className={cx('flex items-center gap-2.5 px-3 py-2 text-[13px]', other ? 'opacity-55' : 'cursor-pointer hover:bg-surface-2')}>
                              <input type="checkbox" className="size-4 accent-[var(--accent)]" disabled={other} checked={set.has(r.id)} onChange={() => toggleIn(set, r.id, setter)} />
                              <span className="flex-1 truncate font-mono text-[12.5px]">{r.name}</span>
                              {other && <span className="text-xs text-muted">{'client_name' in r && r.client_name ? r.client_name : 'otro cliente'}</span>}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {saveResources.error && <ErrorBox error={saveResources.error} />}
              <div className="flex justify-end">
                <Button variant="primary" loading={saveResources.isPending} onClick={() => saveResources.mutate()}>
                  Guardar asignación
                </Button>
              </div>
            </div>
          )}

          {tab === 'users' && (
            <div className="-mx-4 -mb-4">
              <p className="px-4 pb-3 text-[13px] text-muted">Personas que pueden entrar al panel con esta cuenta. Solo ven lo asignado a este cliente.</p>
              <UsersTable users={q.data!.users} onPassword={setShown} invalidate={invalidate} />
              <AddUser
                role="client"
                clientId={clientId!}
                onCreated={(v) => {
                  setShown(v);
                  invalidate();
                }}
              />
            </div>
          )}
        </>
      )}
      <OneTimePassword value={shown} onClose={() => setShown(null)} />
    </Modal>
  );
}

// --- page -----------------------------------------------------------------------------------------

function NewClient({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const [form, setForm] = useState<ClientForm>(emptyForm);
  const create = useMutation({
    mutationFn: () => api.post<ClientAccount>('/api/clients', form),
    onSuccess: (c) => {
      setForm(emptyForm);
      onCreated(c.id);
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nuevo cliente"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={create.isPending} disabled={!form.name.trim()} onClick={() => create.mutate()}>
            Crear
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {create.error && <ErrorBox error={create.error} />}
        <Field label="Nombre">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Tienda Lucía" autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Empresa (opcional)">
            <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </Field>
          <Field label="Email de contacto (opcional)">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
        </div>
        <p className="text-xs text-muted">Después podrás asignarle dominios y crear sus accesos.</p>
      </div>
    </Modal>
  );
}

function Team() {
  const qc = useQueryClient();
  const me = useMe();
  const [shown, setShown] = useState<{ username: string; password: string } | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<PanelUser[]>('/api/users') });
  const team = (users.data ?? []).filter((u) => u.role !== 'client');
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['license'] });
  };
  return (
    <Card title="Tu equipo" icon={<Users />} description="Personas de tu empresa con acceso a todo el panel (menos la gestión del equipo, que es solo del titular)." padded={false}>
      {users.isLoading ? <Spinner /> : <UsersTable users={team} onPassword={setShown} invalidate={invalidate} showClient />}
      {me.data?.role === 'owner' && (
        <AddUser
          role="admin"
          onCreated={(v) => {
            setShown(v);
            invalidate();
          }}
        />
      )}
      <OneTimePassword value={shown} onClose={() => setShown(null)} />
    </Card>
  );
}

export default function Clients() {
  const q = useQuery({ queryKey: ['clients'], queryFn: () => api.get<{ clients: ClientAccount[]; active: number }>('/api/clients') });
  const lic = useLicense();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const list = q.data?.clients ?? [];

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Cada cliente solo ve y gestiona los dominios que le asignes. Tú y tu equipo veis todo."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Nuevo cliente
          </Button>
        }
      />
      <div className="space-y-4">
        {lic.data && (
          <Card>
            <AccessUsage info={lic.data} />
          </Card>
        )}
        <Card padded={false}>
          {q.isLoading ? (
            <Spinner />
          ) : q.error ? (
            <div className="p-4">
              <ErrorBox error={q.error} />
            </div>
          ) : list.length === 0 ? (
            <Empty
              icon={<Users />}
              title="Todavía no tienes clientes"
              description="Crea una cuenta por cada cliente, asígnale sus dominios y dale acceso: solo verá lo suyo."
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  Crear el primero
                </Button>
              }
            />
          ) : (
            <Table head={['Cliente', 'Estado', 'Dominios', 'Sitios', 'Accesos', 'BD', 'Alta']}>
              {list.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setOpenId(c.id)}>
                  <Td>
                    <div className="font-medium">{c.name}</div>
                    {(c.company || c.email) && <div className="text-xs text-muted">{[c.company, c.email].filter(Boolean).join(' · ')}</div>}
                  </Td>
                  <Td>{c.status === 'active' ? <Badge tone="ok" dot>Activo</Badge> : <Badge tone="warn" dot>Suspendido</Badge>}</Td>
                  <Td className="tabular-nums">{c.domains}</Td>
                  <Td className="tabular-nums">{c.sites}</Td>
                  <Td className="tabular-nums">{c.users}</Td>
                  <Td className="tabular-nums">{c.databases}</Td>
                  <Td className="text-xs whitespace-nowrap text-muted">{timeAgo(c.created_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Team />
      </div>
      <NewClient
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          q.refetch();
          setOpenId(id);
        }}
      />
      <ClientModal clientId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
