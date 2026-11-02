import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, Download, File, FileImage, Folder, FolderPlus, Link2, Trash2, Upload } from 'lucide-react';
import { api, upload, type Bucket, type ObjectEntry } from '../lib/api';
import { bytes, timeAgo } from '../lib/format';
import { CodeBlock, TokensPanel } from '../components/TokensPanel';
import { Badge, Button, Card, ConfirmButton, Copyable, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, StickyActions, Table, Tabs, Td, Toggle, cx } from '../components/ui';

interface Listing {
  objects: ObjectEntry[];
  folders: string[];
  truncated: boolean;
}
interface UploadItem {
  name: string;
  progress: number;
  error?: string;
}

function Browser({ bucket }: { bucket: Bucket }) {
  const qc = useQueryClient();
  const [prefix, setPrefix] = useState('');
  const key = ['objects', bucket.id, prefix];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Listing>(`/api/buckets/${bucket.id}/objects?prefix=${encodeURIComponent(prefix)}`) });
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['objects', bucket.id] });
    qc.invalidateQueries({ queryKey: ['buckets'] });
  };

  const uploadFiles = async (files: File[], base = prefix) => {
    if (!files.length) return;
    const items = files.map((f) => ({ name: f.name, progress: 0 }));
    setUploads((u) => [...u, ...items]);
    let ok = 0;
    for (const f of files) {
      // webkitRelativePath keeps folder structure when a folder is dropped/selected.
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const keyName = `${base}${rel}`;
      try {
        await upload(`/api/buckets/${bucket.id}/objects?key=${encodeURIComponent(keyName)}`, f, (p) =>
          setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, progress: p } : x))),
        );
        ok++;
        setUploads((u) => u.filter((x) => x.name !== f.name));
      } catch (err) {
        setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, error: (err as Error).message } : x)));
      }
    }
    if (ok) toast.success(`${ok} archivo${ok === 1 ? '' : 's'} subido${ok === 1 ? '' : 's'}`);
    refresh();
  };

  const remove = useMutation({
    mutationFn: (p: { key?: string; prefix?: string }) =>
      api.del(`/api/buckets/${bucket.id}/objects?${p.key ? `key=${encodeURIComponent(p.key)}` : `prefix=${encodeURIComponent(p.prefix!)}`}`),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });

  const publicUrl = (k: string) => (bucket.public_url ? `${bucket.public_url}/${k.split('/').map(encodeURIComponent).join('/')}` : null);
  const crumbs = prefix ? prefix.replace(/\/$/, '').split('/') : [];

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void uploadFiles([...e.dataTransfer.files]);
      }}
      className="relative"
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/80 text-accent">
          <div className="flex items-center gap-2 font-medium">
            <Upload className="size-5" /> Suelta para subir a /{prefix}
          </div>
        </div>
      )}
      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-[13px]">
            <button className={cx('rounded px-1.5 py-0.5 font-mono hover:bg-surface-2', !prefix && 'font-semibold')} onClick={() => setPrefix('')}>
              {bucket.name}
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-0.5">
                <ChevronRight className="size-3.5 text-muted" />
                <button className="rounded px-1.5 py-0.5 font-mono hover:bg-surface-2" onClick={() => setPrefix(`${crumbs.slice(0, i + 1).join('/')}/`)}>
                  {c}
                </button>
              </span>
            ))}
          </nav>
          <div className="flex gap-1.5">
            <Button size="sm" icon={<FolderPlus className="size-3.5" />} onClick={() => setFolderOpen(true)}>
              Carpeta
            </Button>
            <Button size="sm" variant="primary" icon={<Upload className="size-3.5" />} onClick={() => input.current?.click()}>
              Subir archivos
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void uploadFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        {uploads.length > 0 && (
          <div className="space-y-1.5 border-b border-border px-4 py-3">
            {uploads.map((u) => (
              <div key={u.name} className="flex items-center gap-3 text-[13px]">
                <span className="w-48 truncate">{u.name}</span>
                {u.error ? (
                  <span className="text-danger">{u.error}</span>
                ) : (
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <div className="p-4">
            <ErrorBox error={q.error} />
          </div>
        ) : !q.data!.folders.length && !q.data!.objects.length ? (
          <Empty icon={<Upload className="size-6" />} title="Carpeta vacía" description="Arrastra archivos aquí o usa «Subir archivos»." />
        ) : (
          <Table head={['Nombre', 'Tamaño', 'Tipo', 'Modificado', '']}>
            {q.data!.folders.map((f) => (
              <tr key={f} className="group cursor-pointer hover:bg-surface-2/50" onClick={() => setPrefix(f)}>
                <Td>
                  <span className="flex items-center gap-2 font-medium">
                    <Folder className="size-4 text-accent" />
                    {f.slice(prefix.length)}
                  </span>
                </Td>
                <Td className="text-muted">—</Td>
                <Td className="text-muted">Carpeta</Td>
                <Td />
                <Td className="w-24">
                  <div className="flex justify-end opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      aria-label="Borrar carpeta"
                      title={`Borrar ${f}`}
                      message="Se borrarán la carpeta y todos los archivos que contiene."
                      onConfirm={() => remove.mutateAsync({ prefix: f })}
                    >
                      <Trash2 className="size-3.5" />
                    </ConfirmButton>
                  </div>
                </Td>
              </tr>
            ))}
            {q.data!.objects.map((o) => {
              const url = publicUrl(o.key);
              return (
                <tr key={o.key} className="group">
                  <Td>
                    <span className="flex min-w-0 items-center gap-2">
                      {o.type.startsWith('image/') ? <FileImage className="size-4 shrink-0 text-info" /> : <File className="size-4 shrink-0 text-muted" />}
                      <span className="truncate">{o.key.slice(prefix.length)}</span>
                    </span>
                  </Td>
                  <Td className="tabular whitespace-nowrap">{bytes(o.size)}</Td>
                  <Td className="max-w-40 truncate text-xs text-muted">{o.type.split(';')[0]}</Td>
                  <Td className="whitespace-nowrap text-muted">{timeAgo(o.modified.replace('T', ' ').slice(0, 19))}</Td>
                  <Td className="w-28">
                    <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                      {url && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Copiar URL pública"
                          onClick={async () => {
                            await navigator.clipboard.writeText(url);
                            toast.success('URL copiada');
                          }}
                        >
                          <Link2 className="size-3.5" />
                        </Button>
                      )}
                      <a className="inline-flex h-7 items-center rounded-md px-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Descargar" href={`/api/buckets/${bucket.id}/object?key=${encodeURIComponent(o.key)}`}>
                        <Download className="size-3.5" />
                      </a>
                      <ConfirmButton size="sm" variant="ghost" aria-label="Borrar" title="Borrar archivo" message={o.key} onConfirm={() => remove.mutateAsync({ key: o.key })}>
                        <Trash2 className="size-3.5" />
                      </ConfirmButton>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
        {q.data?.truncated && <p className="border-t border-border px-4 py-2 text-xs text-muted">Se muestran los primeros 1000 archivos de esta carpeta.</p>}
      </Card>

      <Modal
        open={folderOpen}
        onClose={() => setFolderOpen(false)}
        title="Nueva carpeta"
        footer={
          <>
            <Button onClick={() => setFolderOpen(false)}>Cancelar</Button>
            <Button
              variant="primary"
              disabled={!folderName}
              onClick={() => {
                // Folders exist through their files (like S3): open it and upload into it.
                setPrefix(`${prefix}${folderName.replace(/^\/+|\/+$/g, '')}/`);
                setFolderOpen(false);
                setFolderName('');
              }}
            >
              Abrir
            </Button>
          </>
        }
      >
        <Field label="Nombre" hint="La carpeta aparecerá al subir el primer archivo dentro.">
          <Input value={folderName} onChange={(e) => setFolderName(e.target.value.replace(/[^\w.\-/ ]/g, ''))} autoFocus placeholder="fotos/2026" />
        </Field>
      </Modal>
    </div>
  );
}

function Settings({ bucket }: { bucket: Bucket }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ public: bucket.public, hostname: bucket.hostname, cors_origins: bucket.cors_origins, cache_ttl: bucket.cache_ttl });
  useEffect(() => setForm({ public: bucket.public, hostname: bucket.hostname, cors_origins: bucket.cors_origins, cache_ttl: bucket.cache_ttl }), [bucket]);
  const save = useMutation({
    mutationFn: () => api.put<Bucket>(`/api/buckets/${bucket.id}`, form),
    onSuccess: () => {
      toast.success('Bucket actualizado');
      qc.invalidateQueries({ queryKey: ['bucket', bucket.id] });
    },
  });
  return (
    <div className="space-y-4">
      <Card title="Acceso">
        {save.error && <ErrorBox error={save.error} />}
        <div className="divide-y divide-border">
          <Toggle checked={form.public} onChange={(v) => setForm({ ...form, public: v })} label="Lectura pública" description="Cualquiera con la URL puede descargar los archivos. La escritura siempre requiere un token." />
        </div>
        {form.public && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Dominio propio" hint="Registro A/CNAME hacia este servidor; SSL automático.">
              <Input value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value.trim().toLowerCase() })} placeholder="cdn.midominio.com" />
            </Field>
            <Field label="Caché del navegador / CDN (segundos)" hint="86400 = 1 día. 0 = sin caché.">
              <Input type="number" min={0} value={form.cache_ttl} onChange={(e) => setForm({ ...form, cache_ttl: Number(e.target.value) })} />
            </Field>
            <Field label="CORS: orígenes permitidos" className="sm:col-span-2" hint="Separados por comas, o * para cualquiera. Vacío = sin CORS.">
              <Input value={form.cors_origins} onChange={(e) => setForm({ ...form, cors_origins: e.target.value })} placeholder="https://midominio.com, https://app.midominio.com" />
            </Field>
          </div>
        )}
        <StickyActions>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
        </StickyActions>
      </Card>
      <Card title="Zona peligrosa">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-muted">Borra el bucket con todos sus archivos y tokens.</p>
          <ConfirmButton
            variant="danger"
            title={`Eliminar ${bucket.name}`}
            message={`Se borrarán ${bucket.usage?.count ?? 'todos los'} archivos. No se puede deshacer.`}
            onConfirm={async () => {
              await api.del(`/api/buckets/${bucket.id}`);
              qc.invalidateQueries({ queryKey: ['buckets'] });
              navigate('/storage');
            }}
          >
            Eliminar bucket
          </ConfirmButton>
        </div>
      </Card>
    </div>
  );
}

function ApiDocs({ bucket }: { bucket: Bucket }) {
  const base = bucket.api_url;
  return (
    <TokensPanel basePath={`/api/buckets/${bucket.id}`}>
      <Card title="API HTTP">
        <p className="mb-3 text-[13px] text-muted">Sube, descarga y borra archivos desde tus apps o tu CI con un token (cabecera Authorization).</p>
        <Field label="URL base">
          <Copyable value={base} />
        </Field>
        <div className="mt-4 space-y-3">
          <CodeBlock>{`# Subir
curl -X PUT -H "Authorization: Bearer $TOKEN" --data-binary @foto.jpg \\
  ${base}/fotos/foto.jpg

# Descargar${bucket.public ? ' (público: sin token)' : ''}
curl ${bucket.public ? '' : '-H "Authorization: Bearer $TOKEN" '}${base}/fotos/foto.jpg -o foto.jpg

# Listar una carpeta
curl -H "Authorization: Bearer $TOKEN" "${base}?prefix=fotos/"

# Borrar
curl -X DELETE -H "Authorization: Bearer $TOKEN" ${base}/fotos/foto.jpg`}</CodeBlock>
          <CodeBlock>{`// JavaScript (navegador o Node)
await fetch('${base}/docs/informe.pdf', {
  method: 'PUT',
  headers: { Authorization: \`Bearer \${TOKEN}\` },
  body: file,
});`}</CodeBlock>
        </div>
      </Card>
    </TokensPanel>
  );
}

export default function BucketDetail() {
  const { id } = useParams();
  const [tab, setTab] = useState<'files' | 'settings' | 'api'>('files');
  const q = useQuery({
    queryKey: ['bucket', Number(id)],
    queryFn: async () => (await api.get<Bucket[]>('/api/buckets')).find((b) => b.id === Number(id)) ?? null,
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const b = q.data;
  if (!b) return <Empty title="Bucket no encontrado" action={<Link to="/storage" className="text-accent">Volver</Link>} />;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{b.name}</span> {b.public ? <Badge tone="info">Público</Badge> : <Badge>Privado</Badge>}
          </span>
        }
        description={
          <span className="tabular">
            {bytes(b.usage?.size ?? 0)} · {b.usage?.count ?? 0} objetos{b.public_url ? ` · ${b.public_url}` : ''}
          </span>
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'files', label: 'Archivos' },
          { id: 'settings', label: 'Configuración' },
          { id: 'api', label: 'API y tokens' },
        ]}
      />
      {tab === 'files' && <Browser bucket={b} />}
      {tab === 'settings' && <Settings bucket={b} />}
      {tab === 'api' && <ApiDocs bucket={b} />}
    </>
  );
}
