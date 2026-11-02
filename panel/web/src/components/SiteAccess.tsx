import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FolderLock, KeyRound, Lock, Plus, RefreshCw, Settings2, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import { api, type Site } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Badge, Button, Callout, Card, ConfirmButton, Copyable, Empty, ErrorBox, Field, Input, Modal, Spinner, Textarea } from './ui';

/** Shows a new password once; the panel does not keep it. */
function SecretModal({ secret, onClose }: { secret: { title: string; rows: [string, string][] } | null; onClose: () => void }) {
  return (
    <Modal open={!!secret} onClose={onClose} title={secret?.title ?? ''} footer={<Button variant="primary" onClick={onClose}>Hecho</Button>}>
      <p className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">Guarda la contraseña ahora: el panel no la almacena y no podrás volver a verla.</p>
      <div className="space-y-3">
        {secret?.rows.map(([label, value]) => (
          <Field key={label} label={label}>
            <Copyable value={value} />
          </Field>
        ))}
      </div>
    </Modal>
  );
}

// --- SFTP accounts ---------------------------------------------------------------------------

interface SftpAccount {
  id: number;
  username: string;
  note: string;
  public_keys: string;
  keys: { type: string; comment: string }[];
  created_at: string;
  password_changed_at: string;
}
interface SftpData {
  host: string;
  port: number;
  local_only: boolean;
  accounts: SftpAccount[];
}

const KEYS_HINT = 'Una por línea, formato OpenSSH (el contenido de ~/.ssh/id_ed25519.pub). Opcional: si añades una clave, podrás entrar sin contraseña.';

function SftpModal({ site, account, onClose, onCreated }: { site: Site; account?: SftpAccount; onClose: () => void; onCreated: (username: string, password: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ username: '', password: '', note: account?.note ?? '', public_keys: account?.public_keys ?? '' });
  const save = useMutation({
    mutationFn: () =>
      account
        ? api.put(`/api/sites/${site.id}/sftp/${account.id}`, { note: f.note, public_keys: f.public_keys })
        : api.post<{ account: SftpAccount; password: string }>(`/api/sites/${site.id}/sftp`, f),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['sftp', site.id] });
      if (!account) onCreated(f.username.trim().toLowerCase(), (r as { password: string }).password);
      else toast.success('Cuenta actualizada');
      onClose();
    },
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={account ? `Editar ${account.username}` : 'Nueva cuenta SFTP'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} disabled={!account && !f.username.trim()} onClick={() => save.mutate()}>
            {account ? 'Guardar' : 'Crear cuenta'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <ErrorBox error={save.error} />}
        {!account && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Usuario" hint="Minúsculas, números, «-» o «_». Es un usuario del servidor, así que debe ser único.">
              <Input className="font-mono" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder={`${site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'web'}-sftp`} />
            </Field>
            <Field label="Contraseña" hint="Déjala vacía para generar una segura (te la mostraremos una vez).">
              <Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="Generar automáticamente" />
            </Field>
          </div>
        )}
        <Field label="Descripción (opcional)">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Diseñador, agencia, copia externa…" />
        </Field>
        <Field label="Claves públicas SSH" hint={KEYS_HINT}>
          <Textarea className="font-mono text-[12px]" rows={4} value={f.public_keys} onChange={(e) => setF({ ...f, public_keys: e.target.value })} placeholder="ssh-ed25519 AAAAC3Nza… portatil@casa" />
        </Field>
      </div>
    </Modal>
  );
}

export function SftpCard({ site }: { site: Site }) {
  const qc = useQueryClient();
  const key = ['sftp', site.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<SftpData>(`/api/sites/${site.id}/sftp`) });
  const [editing, setEditing] = useState<{ account?: SftpAccount } | null>(null);
  const [secret, setSecret] = useState<{ title: string; rows: [string, string][] } | null>(null);
  const resetPassword = useMutation({
    mutationFn: (a: SftpAccount) => api.post<{ password: string }>(`/api/sites/${site.id}/sftp/${a.id}/password`),
    onSuccess: (r, a) => {
      qc.invalidateQueries({ queryKey: key });
      setSecret({ title: `Nueva contraseña de ${a.username}`, rows: [['Usuario', a.username], ['Contraseña', r.password]] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const add = () => setEditing({});
  const portFlag = d.port === 22 ? '' : ` -P ${d.port}`;
  return (
    <>
      <Card
        padded={false}
        icon={<FolderLock />}
        title="Cuentas SFTP"
        description="Accesos para subir archivos con FileZilla, Cyberduck o WinSCP. Cada cuenta solo ve la carpeta de este sitio y no puede abrir una consola."
        actions={
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={add}>
            Nueva cuenta
          </Button>
        }
      >
        <div className="grid gap-3 border-b border-border px-4 py-3 text-[13px] sm:grid-cols-3">
          <Field label="Servidor">
            <Copyable value={d.host} />
          </Field>
          <Field label="Puerto">
            <Copyable value={String(d.port)} />
          </Field>
          <Field label="Protocolo">
            <div className="py-1.5 text-muted">SFTP (SSH). FTP sin cifrar no está disponible.</div>
          </Field>
        </div>
        {!d.local_only && (
          <div className="border-b border-border px-4 py-3">
            <Callout tone="warn">Este sitio se sirve desde varios servidores. SFTP da acceso a los archivos del servidor principal; los cambios llegan a los demás en el próximo despliegue.</Callout>
          </div>
        )}
        {d.accounts.length === 0 ? (
          <Empty
            icon={<Users className="size-6" />}
            title="Sin cuentas SFTP"
            description="Crea una para que alguien suba o edite archivos de este sitio sin darle acceso al panel ni al resto del servidor."
            action={
              <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={add}>
                Crear cuenta
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {d.accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{a.username}</span>
                    {a.keys.length > 0 && (
                      <Badge tone="info">
                        <KeyRound className="size-3" /> {a.keys.length === 1 ? '1 clave' : `${a.keys.length} claves`}
                      </Badge>
                    )}
                    {a.note && <span className="text-muted">{a.note}</span>}
                  </div>
                  <code className="mt-1 block truncate font-mono text-[12px] text-muted">
                    sftp{portFlag} {a.username}@{d.host}
                  </code>
                  <div className="mt-0.5 text-xs text-muted">
                    Creada {timeAgo(a.created_at)} · contraseña cambiada {timeAgo(a.password_changed_at)}
                    {a.keys.length > 0 && <> · {a.keys.map((k) => k.comment || k.type).join(', ')}</>}
                  </div>
                </div>
                <div className="flex gap-0.5">
                  <ConfirmButton
                    size="sm"
                    icon={<RefreshCw className="size-3.5" />}
                    title="Cambiar contraseña"
                    label="Generar nueva"
                    message={<>Se generará una contraseña nueva para <code className="font-mono">{a.username}</code> y la actual dejará de funcionar.</>}
                    onConfirm={() => resetPassword.mutateAsync(a)}
                  >
                    Contraseña
                  </ConfirmButton>
                  <Button size="sm" variant="ghost" aria-label="Editar" title="Descripción y claves" onClick={() => setEditing({ account: a })}>
                    <Settings2 className="size-3.5" />
                  </Button>
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    aria-label="Eliminar"
                    title="Eliminar cuenta SFTP"
                    message={<>Se borrará el acceso <code className="font-mono">{a.username}</code> y se cerrarán sus sesiones abiertas. Los archivos del sitio no se tocan.</>}
                    onConfirm={async () => {
                      await api.del(`/api/sites/${site.id}/sftp/${a.id}`);
                      qc.invalidateQueries({ queryKey: key });
                      toast.success('Cuenta eliminada');
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </ConfirmButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && (
        <SftpModal
          site={site}
          account={editing.account}
          onClose={() => setEditing(null)}
          onCreated={(username, password) =>
            setSecret({ title: 'Cuenta SFTP creada', rows: [['Servidor', d.host], ['Puerto', String(d.port)], ['Usuario', username], ['Contraseña', password]] })
          }
        />
      )}
      <SecretModal secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}

// --- password-protected paths ----------------------------------------------------------------

interface ProtectedData {
  hostnames: string[];
  paths: { path: string; users: { id: number; username: string; created_at: string }[] }[];
}

function ProtectModal({ site, path, onClose, onCreated }: { site: Site; path?: string; onClose: () => void; onCreated: (r: { path: string; username: string; password: string }) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ path: path ?? '/', username: '', password: '' });
  const save = useMutation({
    mutationFn: () => api.post<{ path: string; username: string; password: string }>(`/api/sites/${site.id}/protected-paths`, f),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['protected-paths', site.id] });
      onCreated(r);
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={path ? `Añadir usuario a ${path}` : 'Proteger una ruta'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.username.trim() || !f.path.trim()} onClick={() => save.mutate()}>
            {path ? 'Añadir usuario' : 'Proteger'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.error && <ErrorBox error={save.error} />}
        {!path && (
          <Field label="Ruta" hint="«/» protege todo el sitio. «/admin» protege /admin y todo lo que cuelga de él.">
            <Input className="font-mono" value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} placeholder="/admin" />
          </Field>
        )}
        <Field label="Usuario">
          <Input autoComplete="off" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="cliente" />
        </Field>
        <Field label="Contraseña" hint="Déjala vacía para generar una segura (te la mostraremos una vez).">
          <Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="Generar automáticamente" />
        </Field>
      </div>
    </Modal>
  );
}

export function ProtectedPathsCard({ site }: { site: Site }) {
  const qc = useQueryClient();
  const key = ['protected-paths', site.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ProtectedData>(`/api/sites/${site.id}/protected-paths`) });
  const [adding, setAdding] = useState<{ path?: string } | null>(null);
  const [secret, setSecret] = useState<{ title: string; rows: [string, string][] } | null>(null);
  const resetPassword = useMutation({
    mutationFn: (u: { id: number; username: string }) => api.post<{ password: string }>(`/api/sites/${site.id}/protected-paths/${u.id}/password`),
    onSuccess: (r, u) => setSecret({ title: `Nueva contraseña de ${u.username}`, rows: [['Usuario', u.username], ['Contraseña', r.password]] }),
    onError: (e) => toast.error((e as Error).message),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const host = d.hostnames[0];
  return (
    <>
      <Card
        padded={false}
        icon={<Lock />}
        title="Rutas protegidas con contraseña"
        description="El navegador pide usuario y contraseña antes de mostrar la ruta. Útil para zonas de clientes, entornos de prueba o paneles internos."
        actions={
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding({})}>
            Proteger ruta
          </Button>
        }
      >
        {d.paths.length === 0 ? (
          <Empty
            icon={<ShieldCheck className="size-6" />}
            title="Ninguna ruta protegida"
            description="Protege todo el sitio mientras lo preparas o solo una carpeta, como /admin o /informes."
            action={
              <Button variant="primary" icon={<Lock className="size-4" />} onClick={() => setAdding({})}>
                Proteger ruta
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {d.paths.map((p) => (
              <li key={p.path} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Lock className="size-3.5 shrink-0 text-muted" />
                    <code className="font-mono font-medium">{p.path}</code>
                    {p.path === '/' && <Badge tone="warn">Todo el sitio</Badge>}
                    {host && (
                      <a href={`https://${host}${p.path}`} target="_blank" rel="noreferrer" className="truncate text-xs text-muted hover:text-accent">
                        {host}
                        {p.path === '/' ? '' : p.path}
                      </a>
                    )}
                  </div>
                  <Button size="sm" variant="ghost" icon={<UserPlus className="size-3.5" />} onClick={() => setAdding({ path: p.path })}>
                    Añadir usuario
                  </Button>
                </div>
                <ul className="mt-2 space-y-1 border-l border-border pl-5">
                  {p.users.map((u) => (
                    <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-mono text-[13px]">{u.username}</span> <span className="text-xs text-muted">· desde {timeAgo(u.created_at)}</span>
                      </span>
                      <div className="flex gap-0.5">
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          icon={<RefreshCw className="size-3.5" />}
                          title="Cambiar contraseña"
                          label="Generar nueva"
                          message={<>Se generará una contraseña nueva para <code className="font-mono">{u.username}</code> en <code className="font-mono">{p.path}</code>.</>}
                          onConfirm={() => resetPassword.mutateAsync(u)}
                        >
                          Contraseña
                        </ConfirmButton>
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          aria-label="Quitar acceso"
                          title="Quitar acceso"
                          label="Quitar"
                          message={
                            p.users.length === 1 ? (
                              <>Es el único usuario: <code className="font-mono">{p.path}</code> quedará abierta al público.</>
                            ) : (
                              <><code className="font-mono">{u.username}</code> ya no podrá entrar en <code className="font-mono">{p.path}</code>.</>
                            )
                          }
                          onConfirm={async () => {
                            await api.del(`/api/sites/${site.id}/protected-paths/${u.id}`);
                            qc.invalidateQueries({ queryKey: key });
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </ConfirmButton>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && (
        <ProtectModal
          site={site}
          path={adding.path}
          onClose={() => setAdding(null)}
          onCreated={(r) => {
            toast.success(`${r.path} protegida`);
            setSecret({ title: `Acceso a ${r.path}`, rows: [['Usuario', r.username], ['Contraseña', r.password]] });
          }}
        />
      )}
      <SecretModal secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}
