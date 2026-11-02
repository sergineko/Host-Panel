import { lazy, Suspense, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ChevronRight,
  Download,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  FolderUp,
  Home,
  Link2,
  PackageOpen,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api, upload } from '../lib/api';
import { bytes, timeAgo } from '../lib/format';
import { languageFor } from './CodeEditor';
import { Badge, Button, Callout, Card, ConfirmButton, Empty, ErrorBox, Field, Input, Modal, Spinner, cx } from './ui';

const CodeEditor = lazy(() => import('./CodeEditor'));

type RootId = 'site' | 'shared';
interface Root {
  id: RootId;
  label: string;
  description: string;
  persistent: boolean;
  size: number | null;
}
interface Entry {
  name: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  modified: string;
  mode: string;
}
interface Listing {
  path: string;
  entries: Entry[];
  truncated: boolean;
}
interface Upload {
  name: string;
  progress: number;
  error?: string;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const isArchive = (n: string) => /\.(zip|tar\.gz|tgz|tar)$/i.test(n);
const TEXT_EXT = /\.(html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|json|md|txt|xml|svg|php|phtml|ini|conf|env|yml|yaml|toml|sh|py|rb|vue|svelte|csv|log|htaccess|gitignore|lock)$/i;
const isText = (n: string) => TEXT_EXT.test(n) || n.startsWith('.') || !n.includes('.');

function EntryIcon({ e }: { e: Entry }) {
  const cls = 'size-4 shrink-0';
  if (e.type === 'dir') return <Folder className={cx(cls, 'fill-accent/15 text-accent')} />;
  if (e.type === 'link') return <Link2 className={cx(cls, 'text-muted')} />;
  if (isArchive(e.name)) return <FileArchive className={cx(cls, 'text-violet')} />;
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(e.name)) return <FileImage className={cx(cls, 'text-ok')} />;
  if (/\.(php|js|mjs|ts|tsx|jsx|css|scss|html?|json|vue)$/i.test(e.name)) return <FileCode className={cx(cls, 'text-info')} />;
  if (isText(e.name)) return <FileText className={cx(cls, 'text-muted')} />;
  return <File className={cx(cls, 'text-muted')} />;
}

// --- editor --------------------------------------------------------------------------------

function FileEditor({ siteId, root, path, onClose }: { siteId: number; root: RootId; path: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['file', siteId, root, path],
    queryFn: () => api.get<{ content: string; modified: string; size: number }>(`/api/sites/${siteId}/files/content?root=${root}&path=${encodeURIComponent(path)}`),
    staleTime: Infinity,
  });
  const [text, setText] = useState<string | null>(null);
  const [modified, setModified] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) {
      setText(q.data.content);
      setModified(q.data.modified);
    }
  }, [q.data]);
  const dirty = q.data !== undefined && text !== null && text !== q.data.content;
  const save = useMutation({
    mutationFn: () => api.put<{ modified: string }>(`/api/sites/${siteId}/files/content`, { root, path, content: text, expected_modified: modified ?? undefined }),
    onSuccess: (r) => {
      setModified(r.modified);
      qc.setQueryData(['file', siteId, root, path], { content: text, modified: r.modified, size: new Blob([text ?? '']).size });
      qc.invalidateQueries({ queryKey: ['files', siteId, root] });
      toast.success('Guardado');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const close = () => {
    if (dirty && !confirm('Tienes cambios sin guardar. ¿Cerrar igualmente?')) return;
    onClose();
  };
  return (
    <Card
      padded={false}
      className="overflow-hidden"
      title={
        <span className="flex min-w-0 items-center gap-2 font-mono text-[13px]">
          <span className="truncate">{path}</span>
          {dirty && <span className="size-2 shrink-0 rounded-full bg-accent" title="Cambios sin guardar" />}
        </span>
      }
      description={q.data ? `${bytes(q.data.size)} · ${languageFor(path) === 'text' ? 'texto' : languageFor(path).toUpperCase()} · Ctrl + S para guardar` : undefined}
      actions={
        <>
          <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
          <Button size="sm" variant="ghost" aria-label="Cerrar editor" onClick={close}>
            <X className="size-4" />
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
        text !== null && (
          <Suspense fallback={<Spinner />}>
            <CodeEditor
              key={path}
              value={text}
              onChange={setText}
              onSave={() => dirty && save.mutate()}
              language={languageFor(path)}
              className="h-[62vh] overflow-hidden bg-[#282c34]"
            />
          </Suspense>
        )
      )}
    </Card>
  );
}

// --- main ------------------------------------------------------------------------------------

export function FileManager({ siteId }: { siteId: number }) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const roots = useQuery({ queryKey: ['file-roots', siteId], queryFn: () => api.get<Root[]>(`/api/sites/${siteId}/files/roots`) });
  const rootId = (params.get('root') as RootId | null) ?? roots.data?.[0]?.id ?? 'site';
  const path = params.get('path') ?? '';
  const editing = params.get('edit');
  const root = roots.data?.find((r) => r.id === rootId);
  const setView = (next: { root?: RootId; path?: string; edit?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.root) p.set('root', next.root);
    if (next.path !== undefined) next.path ? p.set('path', next.path) : p.delete('path');
    if (next.edit !== undefined) next.edit ? p.set('edit', next.edit) : p.delete('edit');
    setParams(p);
  };

  const list = useQuery({
    queryKey: ['files', siteId, rootId, path],
    queryFn: () => api.get<Listing>(`/api/sites/${siteId}/files?root=${rootId}&path=${encodeURIComponent(path)}`),
    enabled: !!root,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['files', siteId, rootId] });

  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [prompt, setPrompt] = useState<{ kind: 'folder' | 'file' | 'rename'; value: string; from?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => setSelected(new Set()), [rootId, path]);

  const entries = useMemo(() => {
    const all = list.data?.entries ?? [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((e) => e.name.toLowerCase().includes(f)) : all;
  }, [list.data, filter]);

  const action = useMutation({
    mutationFn: async (a: { kind: 'folder' | 'file' | 'rename'; value: string; from?: string }) => {
      const name = a.value.trim();
      if (a.kind === 'folder') return api.post(`/api/sites/${siteId}/files/mkdir`, { root: rootId, path: join(path, name) });
      if (a.kind === 'file') return api.put(`/api/sites/${siteId}/files/content`, { root: rootId, path: join(path, name), content: '', create: true });
      return api.post(`/api/sites/${siteId}/files/rename`, { root: rootId, from: join(path, a.from!), to: join(path, name) });
    },
    onSuccess: (_r, a) => {
      setPrompt(null);
      refresh();
      if (a.kind === 'file') setView({ edit: join(path, a.value.trim()) });
    },
  });
  const extract = useMutation({
    mutationFn: (name: string) => api.post(`/api/sites/${siteId}/files/extract`, { root: rootId, path: join(path, name) }),
    onSuccess: (_r, name) => {
      toast.success(`${name} descomprimido`);
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = async (names: string[]) => {
    await api.post(`/api/sites/${siteId}/files/delete`, { root: rootId, paths: names.map((n) => join(path, n)) });
    setSelected(new Set());
    refresh();
    toast.success(names.length === 1 ? `${names[0]} eliminado` : `${names.length} elementos eliminados`);
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    const existing = new Set(list.data?.entries.map((e) => e.name));
    const clash = files.filter((f) => existing.has(f.name));
    const overwrite = clash.length ? confirm(`Ya existe${clash.length > 1 ? 'n' : ''} ${clash.map((f) => f.name).join(', ')}. ¿Reemplazar?`) : false;
    const queue = files.filter((f) => overwrite || !existing.has(f.name));
    setUploads(queue.map((f) => ({ name: f.name, progress: 0 })));
    let ok = 0;
    for (const [i, f] of queue.entries()) {
      try {
        await upload(
          `/api/sites/${siteId}/files/upload?root=${rootId}&path=${encodeURIComponent(join(path, f.name))}&overwrite=${overwrite ? 1 : 0}`,
          f,
          (p) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, progress: p } : x))),
        );
        ok++;
        setUploads((u) => u.map((x, j) => (j === i ? { ...x, progress: 1 } : x)));
      } catch (err) {
        setUploads((u) => u.map((x, j) => (j === i ? { ...x, error: (err as Error).message } : x)));
      }
    }
    refresh();
    if (ok) toast.success(ok === 1 ? `${queue[0]!.name} subido` : `${ok} archivos subidos`);
    setTimeout(() => setUploads((u) => u.filter((x) => x.error)), 2500);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void uploadFiles([...e.dataTransfer.files]);
  };

  if (roots.isLoading) return <Spinner />;
  if (roots.error) return <ErrorBox error={roots.error} />;
  if (editing) return <FileEditor siteId={siteId} root={rootId} path={editing} onClose={() => setView({ edit: null })} />;

  const crumbs = path ? path.split('/') : [];
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.name));
  const download = (name: string) => window.open(`/api/sites/${siteId}/files/download?root=${rootId}&path=${encodeURIComponent(join(path, name))}`, '_blank');

  return (
    <div className="space-y-3">
      {/* Root switcher: live files vs. persistent shared folder */}
      {(roots.data?.length ?? 0) > 1 && (
        <div className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5">
          {roots.data!.map((r) => (
            <button
              key={r.id}
              onClick={() => setView({ root: r.id, path: '', edit: null })}
              className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors', r.id === rootId ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg')}
            >
              {r.label}
              {r.size !== null && <span className="ml-1.5 text-xs text-muted">{bytes(r.size)}</span>}
            </button>
          ))}
        </div>
      )}
      {root && !root.persistent && (
        <Callout tone="warn" title="Los cambios aquí no son permanentes">
          {root.description}
        </Callout>
      )}

      <Card padded={false}>
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <nav aria-label="Carpeta" className="flex w-full min-w-0 flex-wrap items-center gap-0.5 text-[13px] sm:w-auto sm:flex-1">
            <button onClick={() => setView({ path: '' })} className="flex items-center gap-1 rounded-md px-1.5 py-1 font-medium text-muted hover:bg-surface-2 hover:text-fg">
              <Home className="size-3.5" /> {root?.label}
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-0.5">
                <ChevronRight className="size-3.5 text-muted/60" />
                <button
                  onClick={() => setView({ path: crumbs.slice(0, i + 1).join('/') })}
                  className={cx('rounded-md px-1.5 py-1 font-mono hover:bg-surface-2', i === crumbs.length - 1 ? 'font-medium text-fg' : 'text-muted hover:text-fg')}
                >
                  {c}
                </button>
              </span>
            ))}
          </nav>
          <div className="relative min-w-28 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
            <Input className="h-8 pl-8 text-[13px] sm:!w-44" placeholder="Filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <Button size="sm" variant="ghost" aria-label="Actualizar" loading={list.isFetching} onClick={refresh}>
            <RefreshCw className="size-3.5" />
          </Button>
          <Button size="sm" icon={<FolderPlus className="size-3.5" />} onClick={() => setPrompt({ kind: 'folder', value: '' })}>
            Carpeta
          </Button>
          <Button size="sm" icon={<FilePlus className="size-3.5" />} onClick={() => setPrompt({ kind: 'file', value: '' })}>
            Archivo
          </Button>
          <Button size="sm" variant="primary" icon={<Upload className="size-3.5" />} onClick={() => fileInput.current?.click()}>
            Subir
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void uploadFiles(files);
            }}
          />
        </div>

        {/* Selection bar */}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 border-b border-border bg-accent-soft/50 px-4 py-2 text-[13px]">
            <span className="font-medium">
              {selected.size} seleccionado{selected.size === 1 ? '' : 's'}
            </span>
            <ConfirmButton
              size="sm"
              variant="danger"
              icon={<Trash2 className="size-3.5" />}
              title={`Eliminar ${selected.size} elemento${selected.size === 1 ? '' : 's'}`}
              message={
                <>
                  Se borrarán <span className="font-mono text-fg">{[...selected].slice(0, 5).join(', ')}</span>
                  {selected.size > 5 ? ` y ${selected.size - 5} más` : ''}, con todo su contenido. No se puede deshacer.
                </>
              }
              onConfirm={() => remove([...selected])}
            >
              Eliminar
            </ConfirmButton>
            <button className="ml-auto text-xs text-muted hover:text-fg" onClick={() => setSelected(new Set())}>
              Quitar selección
            </button>
          </div>
        )}

        {/* Upload progress */}
        {uploads.length > 0 && (
          <ul className="space-y-1.5 border-b border-border px-4 py-2.5">
            {uploads.map((u, i) => (
              <li key={i} className="text-[12.5px]">
                <div className="flex justify-between gap-3">
                  <span className="truncate font-mono">{u.name}</span>
                  <span className={cx('tabular shrink-0', u.error ? 'text-danger' : 'text-muted')}>{u.error ?? `${Math.round(u.progress * 100)} %`}</span>
                </div>
                {!u.error && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${u.progress * 100}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Listing (drop zone) */}
        <div
          className="relative min-h-48"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
          onDrop={onDrop}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/80 text-accent">
              <div className="flex flex-col items-center gap-2 font-medium">
                <FolderUp className="size-7" />
                Suelta para subir a /{path}
              </div>
            </div>
          )}
          {list.isLoading ? (
            <Spinner />
          ) : list.error ? (
            <div className="p-4">
              <ErrorBox error={list.error} />
            </div>
          ) : entries.length === 0 ? (
            <Empty
              icon={<FolderUp className="size-6" />}
              title={filter ? 'Nada coincide con el filtro' : 'Carpeta vacía'}
              description={filter ? undefined : 'Arrastra archivos aquí o usa «Subir». Para subir una web entera, sube un .zip y descomprímelo con un clic.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-surface-2/50 text-[11.5px] tracking-wide text-muted uppercase">
                    <th className="w-10 px-4 py-2">
                      <input
                        type="checkbox"
                        aria-label="Seleccionar todo"
                        className="size-4 accent-[var(--accent)]"
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.name)))}
                      />
                    </th>
                    <th className="px-2 py-2 font-medium">Nombre</th>
                    <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Tamaño</th>
                    <th className="hidden px-3 py-2 font-medium md:table-cell">Modificado</th>
                    <th className="hidden px-3 py-2 font-medium lg:table-cell">Permisos</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {path && (
                    <tr className="hover:bg-surface-2/40">
                      <td />
                      <td colSpan={5} className="px-2 py-2">
                        <button className="flex items-center gap-2.5 text-muted hover:text-fg" onClick={() => setView({ path: crumbs.slice(0, -1).join('/') })}>
                          <Folder className="size-4" /> ..
                        </button>
                      </td>
                    </tr>
                  )}
                  {entries.map((e) => {
                    const open = () => (e.type === 'dir' ? setView({ path: join(path, e.name) }) : isText(e.name) ? setView({ edit: join(path, e.name) }) : download(e.name));
                    return (
                      <tr key={e.name} className={cx('group transition-colors hover:bg-surface-2/40', selected.has(e.name) && 'bg-accent-soft/40')}>
                        <td className="px-4 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={`Seleccionar ${e.name}`}
                            className="size-4 accent-[var(--accent)]"
                            checked={selected.has(e.name)}
                            onChange={() =>
                              setSelected((s) => {
                                const n = new Set(s);
                                if (n.has(e.name)) n.delete(e.name);
                                else n.add(e.name);
                                return n;
                              })
                            }
                          />
                        </td>
                        <td className="max-w-0 px-2 py-1.5">
                          <button onClick={open} className="flex w-full min-w-0 items-center gap-2.5 text-left hover:text-accent" title={e.type === 'file' && !isText(e.name) ? 'Descargar' : 'Abrir'}>
                            <EntryIcon e={e} />
                            <span className="truncate font-mono">{e.name}</span>
                            {e.type === 'link' && <Badge>enlace</Badge>}
                          </button>
                        </td>
                        <td className="tabular hidden px-3 py-1.5 text-right whitespace-nowrap text-muted sm:table-cell">{e.type === 'dir' ? '—' : bytes(e.size)}</td>
                        <td className="hidden px-3 py-1.5 whitespace-nowrap text-muted md:table-cell">{timeAgo(e.modified)}</td>
                        <td className="hidden px-3 py-1.5 font-mono text-xs text-muted lg:table-cell">{e.mode}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex justify-end gap-0.5 opacity-50 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            {isArchive(e.name) && (
                              <Button size="sm" variant="ghost" aria-label={`Descomprimir ${e.name}`} title="Descomprimir aquí" loading={extract.isPending && extract.variables === e.name} onClick={() => extract.mutate(e.name)}>
                                <PackageOpen className="size-3.5" />
                              </Button>
                            )}
                            {e.type !== 'dir' && (
                              <Button size="sm" variant="ghost" aria-label={`Descargar ${e.name}`} title="Descargar" onClick={() => download(e.name)}>
                                <Download className="size-3.5" />
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" aria-label={`Renombrar ${e.name}`} title="Renombrar o mover" onClick={() => setPrompt({ kind: 'rename', value: e.name, from: e.name })}>
                              <Pencil className="size-3.5" />
                            </Button>
                            <ConfirmButton
                              size="sm"
                              variant="ghost"
                              aria-label={`Eliminar ${e.name}`}
                              title={`Eliminar ${e.name}`}
                              message={e.type === 'dir' ? 'Se borrará la carpeta con todo su contenido. No se puede deshacer.' : 'Se borrará el archivo. No se puede deshacer.'}
                              onConfirm={() => remove([e.name])}
                            >
                              <Trash2 className="size-3.5" />
                            </ConfirmButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {list.data && (
          <div className="flex flex-wrap justify-between gap-2 border-t border-border px-4 py-2 text-xs text-muted">
            <span>
              {list.data.entries.filter((e) => e.type === 'dir').length} carpetas · {list.data.entries.filter((e) => e.type !== 'dir').length} archivos
              {list.data.truncated && ' · se muestran los primeros 5000'}
            </span>
            <span>Arrastra archivos sobre la lista para subirlos</span>
          </div>
        )}
      </Card>

      <Modal
        open={!!prompt}
        onClose={() => setPrompt(null)}
        title={prompt?.kind === 'folder' ? 'Nueva carpeta' : prompt?.kind === 'file' ? 'Nuevo archivo' : `Renombrar ${prompt?.from ?? ''}`}
        footer={
          <>
            <Button onClick={() => setPrompt(null)}>Cancelar</Button>
            <Button variant="primary" disabled={!prompt?.value.trim() || prompt.value === prompt.from} loading={action.isPending} onClick={() => prompt && action.mutate(prompt)}>
              {prompt?.kind === 'rename' ? 'Renombrar' : 'Crear'}
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (prompt?.value.trim()) action.mutate(prompt);
          }}
        >
          {action.error && <ErrorBox error={action.error} />}
          <Field label="Nombre" hint={prompt?.kind === 'rename' ? 'Para moverlo a otra carpeta, escribe la ruta: assets/logo.png' : `Se creará en /${path}`}>
            <Input className="font-mono" value={prompt?.value ?? ''} onChange={(e) => prompt && setPrompt({ ...prompt, value: e.target.value })} placeholder={prompt?.kind === 'folder' ? 'imagenes' : 'index.html'} />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
