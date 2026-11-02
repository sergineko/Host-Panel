import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Boxes, ChevronLeft, ChevronRight, Download, FileJson, FolderPlus, Layers, ListTree, Pencil, Play, Plus, Search, Trash2, Upload } from 'lucide-react';
import { api, upload, type NosqlCollection, type NosqlDatabase, type NosqlDoc } from '../lib/api';
import { bytes, compact, timeAgo } from '../lib/format';
import { CodeBlock, TokensPanel } from '../components/TokensPanel';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmButton,
  Copyable,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatCard,
  Tabs,
  Textarea,
  Toggle,
  cx,
} from '../components/ui';

const PAGE = 25;

/** Parses a JSON text box; empty means "no value". Throws a readable error. */
function parseJson(text: string, what: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what}: JSON no válido (${(e as Error).message})`);
  }
}

const docAction = <T,>(db: number, collection: string, action: string, body: unknown) =>
  api.post<T & { durationMs: number }>(`/api/nosql/${db}/collections/${encodeURIComponent(collection)}/${action}`, body);

// --- list ----------------------------------------------------------------------------------

export function NosqlList() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['nosql'], queryFn: () => api.get<NosqlDatabase[]>('/api/nosql') });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<NosqlDatabase>('/api/nosql', { name, note }),
    onSuccess: (db) => {
      setOpen(false);
      setName('');
      setNote('');
      toast.success(`Base de datos ${db.name} creada`);
      qc.invalidateQueries({ queryKey: ['nosql'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Bases de datos NoSQL"
        description="Documentos JSON en colecciones, sin esquema. Consúltalas desde el panel, desde tus Workers o con la API HTTP."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
            Nueva base de datos
          </Button>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : q.data!.length === 0 ? (
        <Card>
          <Empty
            icon={<Boxes className="size-6" />}
            title="Sin bases de datos NoSQL"
            description="Guarda documentos JSON (usuarios, pedidos, ajustes…) y búscalos por cualquier campo, sin definir tablas."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
                Crear la primera
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {q.data!.map((d) => (
            <Link
              key={d.id}
              to={`/nosql/${d.id}`}
              className="group rounded-xl border border-border bg-surface p-4 shadow-card transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-accent/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-info-soft text-info">
                    <Boxes className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-mono font-semibold group-hover:text-accent">{d.name}</div>
                    <div className="truncate text-xs text-muted">{d.note || `Creada ${timeAgo(d.created_at)}`}</div>
                  </div>
                </div>
                {d.workers.length > 0 && <Badge tone="info">{d.workers.length} worker{d.workers.length === 1 ? '' : 's'}</Badge>}
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                {[
                  ['Colecciones', compact(d.collections)],
                  ['Documentos', compact(d.documents)],
                  ['Tamaño', bytes(d.size)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-surface-2 px-2 py-1.5">
                    <dt className="text-[11px] text-muted">{k}</dt>
                    <dd className="tabular text-[13px] font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
            </Link>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nueva base de datos NoSQL"
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
          <Field label="Nombre" hint="Empieza por letra; letras, números, guion y guion bajo. Forma parte de la URL de la API.">
            <Input value={name} onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))} placeholder="tienda" autoFocus />
          </Field>
          <Field label="Nota (opcional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pedidos y carritos de la tienda" />
          </Field>
        </div>
      </Modal>
    </>
  );
}

// --- documents -------------------------------------------------------------------------------

function DocEditor({
  db,
  collection,
  doc,
  onClose,
}: {
  db: number;
  collection: string;
  /** null = new document. */
  doc: NosqlDoc | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState(() => {
    if (!doc) return '{\n  \n}';
    const { _id, ...rest } = doc;
    void _id;
    return JSON.stringify(rest, null, 2);
  });
  const [id, setId] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      const body = parseJson(text, 'Documento');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('El documento debe ser un objeto JSON { … }');
      if (doc) return docAction(db, collection, 'replaceOne', { filter: { _id: doc._id }, document: body });
      return docAction(db, collection, 'insertOne', { document: id.trim() ? { _id: id.trim(), ...body } : body });
    },
    onSuccess: () => {
      toast.success(doc ? 'Documento guardado' : 'Documento creado');
      qc.invalidateQueries({ queryKey: ['nosql-docs', db, collection] });
      qc.invalidateQueries({ queryKey: ['nosql-collections', db] });
      onClose();
    },
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={doc ? <span>Editar <span className="font-mono text-muted">{doc._id}</span></span> : `Nuevo documento en ${collection}`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {save.error && <ErrorBox error={save.error} />}
        {!doc && (
          <Field label="_id (opcional)" hint="Si lo dejas vacío se genera uno aleatorio.">
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="automático" className="font-mono" />
          </Field>
        )}
        <Field label="Contenido (JSON)">
          <Textarea className="min-h-72" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function Documents({ db, collections }: { db: NosqlDatabase; collections: NosqlCollection[] }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(collections[0]?.name ?? null);
  const [page, setPage] = useState(0);
  const [filterText, setFilterText] = useState('');
  const [filter, setFilter] = useState<unknown>(undefined);
  const [filterError, setFilterError] = useState('');
  const [editing, setEditing] = useState<NosqlDoc | null | 'new'>(null);
  const [newColl, setNewColl] = useState<string | null>(null);
  const current = collections.find((c) => c.name === selected) ?? null;

  const docs = useQuery({
    queryKey: ['nosql-docs', db.id, selected, page, JSON.stringify(filter ?? null)],
    queryFn: async () => {
      const [list, total] = await Promise.all([
        docAction<{ documents: NosqlDoc[] }>(db.id, selected!, 'find', { filter, limit: PAGE, skip: page * PAGE }),
        docAction<{ count: number }>(db.id, selected!, 'count', { filter }),
      ]);
      return { documents: list.documents, count: total.count };
    },
    enabled: !!selected && !!current,
  });

  const createColl = useMutation({
    mutationFn: (name: string) => api.post(`/api/nosql/${db.id}/collections`, { name }),
    onSuccess: (_r, name) => {
      setNewColl(null);
      setSelected(name);
      qc.invalidateQueries({ queryKey: ['nosql-collections', db.id] });
    },
  });

  const applyFilter = () => {
    try {
      setFilter(parseJson(filterText, 'Filtro'));
      setFilterError('');
      setPage(0);
    } catch (e) {
      setFilterError((e as Error).message);
    }
  };

  const total = docs.data?.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <Card
        padded={false}
        className="h-fit"
        title="Colecciones"
        actions={
          <Button size="sm" variant="ghost" aria-label="Nueva colección" onClick={() => setNewColl('')}>
            <FolderPlus className="size-4" />
          </Button>
        }
      >
        {collections.length === 0 ? (
          <p className="p-4 text-[13px] text-muted">Sin colecciones. Se crean solas al insertar el primer documento, o créalas aquí.</p>
        ) : (
          <ul className="max-h-[520px] overflow-y-auto p-1.5">
            {collections.map((c) => (
              <li key={c.name}>
                <button
                  className={cx(
                    'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left',
                    selected === c.name ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                  )}
                  onClick={() => {
                    setSelected(c.name);
                    setPage(0);
                  }}
                >
                  <span className="truncate font-mono text-[13px]">{c.name}</span>
                  <span className="tabular text-xs text-muted">{compact(c.count)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!current ? (
        <Card>
          <Empty
            icon={<Layers className="size-6" />}
            title="Elige o crea una colección"
            description="Una colección agrupa documentos parecidos, como «usuarios» o «pedidos»."
            action={
              <Button variant="primary" icon={<FolderPlus className="size-4" />} onClick={() => setNewColl('')}>
                Nueva colección
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
              <Input
                className="pl-9 font-mono text-[13px]"
                placeholder='Filtro, por ejemplo { "estado": "pagado", "total": { "$gt": 50 } }'
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyFilter()}
              />
            </div>
            <Button onClick={applyFilter}>Filtrar</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Documento
            </Button>
          </div>
          {filterError && <ErrorBox error={filterError} />}
          <Card
            padded={false}
            title={<span className="font-mono">{current.name}</span>}
            description={`${compact(total)} documento${total === 1 ? '' : 's'}${filter ? ' con el filtro' : ''} · ${bytes(current.size)}`}
            actions={
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Página anterior">
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="tabular text-xs text-muted">
                  {page + 1} / {pages}
                </span>
                <Button size="sm" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label="Página siguiente">
                  <ChevronRight className="size-4" />
                </Button>
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  aria-label="Eliminar colección"
                  title={`Eliminar la colección ${current.name}`}
                  message={`Se borrarán sus ${current.count} documentos y sus índices. No se puede deshacer.`}
                  onConfirm={async () => {
                    await api.del(`/api/nosql/${db.id}/collections/${encodeURIComponent(current.name)}`);
                    setSelected(null);
                    qc.invalidateQueries({ queryKey: ['nosql-collections', db.id] });
                  }}
                >
                  <Trash2 className="size-3.5" />
                </ConfirmButton>
              </div>
            }
          >
            {docs.isLoading ? (
              <Spinner />
            ) : docs.error ? (
              <div className="p-4">
                <ErrorBox error={docs.error} />
              </div>
            ) : docs.data!.documents.length === 0 ? (
              <Empty icon={<FileJson className="size-6" />} title={filter ? 'Ningún documento coincide' : 'Colección vacía'} />
            ) : (
              <ul className="divide-y divide-border">
                {docs.data!.documents.map((d) => (
                  <li key={d._id} className="group relative px-4 py-3 hover:bg-surface-2/40">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-muted">_id: {d._id}</span>
                      <div className="flex gap-0.5 opacity-60 group-hover:opacity-100">
                        <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEditing(d)}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          aria-label="Eliminar"
                          title="Eliminar documento"
                          message={<>Se borrará el documento <span className="font-mono">{d._id}</span>.</>}
                          onConfirm={async () => {
                            await docAction(db.id, current.name, 'deleteOne', { filter: { _id: d._id } });
                            qc.invalidateQueries({ queryKey: ['nosql-docs', db.id, current.name] });
                            qc.invalidateQueries({ queryKey: ['nosql-collections', db.id] });
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </ConfirmButton>
                      </div>
                    </div>
                    <pre className="max-h-48 overflow-auto font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
                      {JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== '_id')), null, 2)}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {editing !== null && current && <DocEditor db={db.id} collection={current.name} doc={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}

      <Modal
        open={newColl !== null}
        onClose={() => setNewColl(null)}
        title="Nueva colección"
        footer={
          <>
            <Button onClick={() => setNewColl(null)}>Cancelar</Button>
            <Button variant="primary" disabled={!newColl} loading={createColl.isPending} onClick={() => createColl.mutate(newColl!)}>
              Crear
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {createColl.error && <ErrorBox error={createColl.error} />}
          <Field label="Nombre" hint="Letras, números, punto, guion y guion bajo.">
            <Input value={newColl ?? ''} onChange={(e) => setNewColl(e.target.value.replace(/[^a-zA-Z0-9_.-]/g, ''))} placeholder="pedidos" autoFocus />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

// --- console ---------------------------------------------------------------------------------

const ACTIONS: { id: string; label: string; example: string }[] = [
  { id: 'find', label: 'find — buscar', example: '{\n  "filter": { "total": { "$gte": 20 } },\n  "sort": { "total": -1 },\n  "limit": 20\n}' },
  { id: 'findOne', label: 'findOne — primero que coincida', example: '{\n  "filter": { "email": "ana@ejemplo.com" }\n}' },
  { id: 'count', label: 'count — contar', example: '{\n  "filter": { "estado": "pendiente" }\n}' },
  { id: 'insertOne', label: 'insertOne — insertar uno', example: '{\n  "document": { "nombre": "Ana", "total": 42, "tags": ["vip"] }\n}' },
  { id: 'insertMany', label: 'insertMany — insertar varios', example: '{\n  "documents": [{ "nombre": "Luis" }, { "nombre": "Marta" }]\n}' },
  { id: 'updateOne', label: 'updateOne — modificar uno', example: '{\n  "filter": { "nombre": "Ana" },\n  "update": { "$inc": { "total": 5 }, "$push": { "tags": "fiel" } }\n}' },
  { id: 'updateMany', label: 'updateMany — modificar varios', example: '{\n  "filter": { "estado": "pendiente" },\n  "update": { "$set": { "estado": "enviado" }, "$currentDate": { "enviado_en": true } }\n}' },
  { id: 'replaceOne', label: 'replaceOne — reemplazar', example: '{\n  "filter": { "_id": "..." },\n  "document": { "nombre": "Ana", "total": 0 },\n  "upsert": true\n}' },
  { id: 'deleteOne', label: 'deleteOne — borrar uno', example: '{\n  "filter": { "_id": "..." }\n}' },
  { id: 'deleteMany', label: 'deleteMany — borrar varios', example: '{\n  "filter": { "estado": "cancelado" }\n}' },
];

function Console({ db, collections }: { db: NosqlDatabase; collections: NosqlCollection[] }) {
  const qc = useQueryClient();
  const [collection, setCollection] = useState(collections[0]?.name ?? '');
  const [action, setAction] = useState('find');
  const [body, setBody] = useState(ACTIONS[0]!.example);
  const run = useMutation({
    mutationFn: () => docAction<Record<string, unknown>>(db.id, collection, action, parseJson(body, 'Cuerpo') ?? {}),
    onSuccess: () => {
      if (!['find', 'findOne', 'count'].includes(action)) {
        qc.invalidateQueries({ queryKey: ['nosql-docs', db.id] });
        qc.invalidateQueries({ queryKey: ['nosql-collections', db.id] });
      }
    },
  });
  const result = run.data ? Object.fromEntries(Object.entries(run.data).filter(([k]) => k !== 'durationMs')) : null;
  return (
    <div className="space-y-4">
      <Card padded={false}>
        <div className="grid gap-3 border-b border-border p-3 sm:grid-cols-2">
          <Field label="Colección" hint="Si no existe, se crea al escribir en ella.">
            <Input list="nosql-colls" value={collection} onChange={(e) => setCollection(e.target.value)} className="font-mono" placeholder="pedidos" />
            <datalist id="nosql-colls">
              {collections.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
          </Field>
          <Field label="Operación">
            <Select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setBody(ACTIONS.find((a) => a.id === e.target.value)!.example);
              }}
            >
              {ACTIONS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Textarea
          className="min-h-44 rounded-none border-0 border-b !shadow-none !ring-0"
          value={body}
          spellCheck={false}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              if (collection) run.mutate();
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="text-xs text-muted">
            Operadores: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex $contains $size $and $or $nor · Ctrl + Enter
          </span>
          <Button variant="primary" size="sm" icon={<Play className="size-3.5" />} disabled={!collection} loading={run.isPending} onClick={() => run.mutate()}>
            Ejecutar
          </Button>
        </div>
      </Card>
      {run.error && <ErrorBox error={run.error} />}
      {result && (
        <Card title="Resultado" description={`${run.data!.durationMs} ms`} padded={false}>
          <pre className="max-h-[480px] overflow-auto p-4 font-mono text-[12.5px] leading-relaxed">{JSON.stringify(result, null, 2)}</pre>
        </Card>
      )}
    </div>
  );
}

// --- indexes ---------------------------------------------------------------------------------

function Indexes({ db, collections }: { db: NosqlDatabase; collections: NosqlCollection[] }) {
  const qc = useQueryClient();
  const [collection, setCollection] = useState(collections[0]?.name ?? '');
  const [field, setField] = useState('');
  const [unique, setUnique] = useState(false);
  const add = useMutation({
    mutationFn: () => api.post(`/api/nosql/${db.id}/collections/${encodeURIComponent(collection)}/indexes`, { field, unique }),
    onSuccess: () => {
      toast.success('Índice creado');
      setField('');
      setUnique(false);
      qc.invalidateQueries({ queryKey: ['nosql-collections', db.id] });
    },
  });
  const withIndexes = collections.filter((c) => c.indexes.length);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card title="Índices" description="Aceleran los filtros y la ordenación por un campo. Un índice único impide valores repetidos." padded={false}>
        {withIndexes.length === 0 ? (
          <Empty icon={<ListTree className="size-6" />} title="Sin índices" description="Crea uno en los campos por los que más filtras, como email o estado." />
        ) : (
          <ul className="divide-y divide-border">
            {withIndexes.flatMap((c) =>
              c.indexes.map((i) => (
                <li key={`${c.name}.${i.field}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="min-w-0 truncate font-mono text-[13px]">
                    <span className="text-muted">{c.name}.</span>
                    {i.field}
                  </span>
                  <div className="flex items-center gap-2">
                    {i.unique ? <Badge tone="violet">Único</Badge> : <Badge>Normal</Badge>}
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      aria-label="Eliminar índice"
                      title="Eliminar índice"
                      message={`Se eliminará el índice de ${c.name}.${i.field}. Los documentos no se tocan.`}
                      onConfirm={async () => {
                        await api.del(`/api/nosql/${db.id}/collections/${encodeURIComponent(c.name)}/indexes/${encodeURIComponent(i.field)}`);
                        qc.invalidateQueries({ queryKey: ['nosql-collections', db.id] });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </ConfirmButton>
                  </div>
                </li>
              )),
            )}
          </ul>
        )}
      </Card>
      <Card title="Nuevo índice" className="h-fit">
        <div className="space-y-3">
          {add.error && <ErrorBox error={add.error} />}
          <Field label="Colección">
            <Input list="nosql-idx-colls" value={collection} onChange={(e) => setCollection(e.target.value)} className="font-mono" />
            <datalist id="nosql-idx-colls">
              {collections.map((c) => (
                <option key={c.name} value={c.name} />
              ))}
            </datalist>
          </Field>
          <Field label="Campo" hint="Usa puntos para campos anidados: cliente.email">
            <Input value={field} onChange={(e) => setField(e.target.value)} className="font-mono" placeholder="email" />
          </Field>
          <Toggle checked={unique} onChange={setUnique} label="Único" description="Rechaza documentos con un valor ya usado." />
          <Button variant="primary" className="w-full" disabled={!collection || !field} loading={add.isPending} onClick={() => add.mutate()}>
            Crear índice
          </Button>
        </div>
      </Card>
    </div>
  );
}

// --- API and backups -------------------------------------------------------------------------

function ApiTab({ db }: { db: NosqlDatabase }) {
  return (
    <TokensPanel basePath={`/api/nosql/${db.id}`}>
      <Card title="API HTTP" description="Lee y escribe documentos desde cualquier aplicación con un token.">
        <Field label="Endpoint base">
          <Copyable value={`${db.api_url}/<colección>/<operación>`} />
        </Field>
        <div className="mt-4 space-y-3">
          <CodeBlock>{`const res = await fetch('${db.api_url}/pedidos/find', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${TOKEN}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ filter: { estado: 'pagado' }, sort: { total: -1 }, limit: 10 }),
});
const { documents } = await res.json();`}</CodeBlock>
          <CodeBlock>{`curl -X POST ${db.api_url}/pedidos/insertOne \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{ "document": { "cliente": "ana@ejemplo.com", "total": 42.5 } }'`}</CodeBlock>
        </div>
      </Card>
      <Card title="Desde un Worker" description="Añade un binding de tipo «Base de datos NoSQL» al Worker y úsalo así:">
        <CodeBlock>{`export default {
  async fetch(request, env) {
    const pedidos = env.DOCS.collection('pedidos');
    await pedidos.insertOne({ total: 42.5, estado: 'pendiente' });
    const pendientes = await pedidos.find({ estado: 'pendiente' }, { limit: 20 });
    return Response.json(pendientes);
  },
};`}</CodeBlock>
      </Card>
    </TokensPanel>
  );
}

function Backup({ db }: { db: NosqlDatabase }) {
  const qc = useQueryClient();
  const [importing, setImporting] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Exportar" icon={<Download />}>
        <p className="mb-4 text-[13px] text-muted">Descarga todas las colecciones, documentos e índices en un archivo .jsonl (un objeto JSON por línea).</p>
        <a
          href={`/api/nosql/${db.id}/export`}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 font-medium shadow-card hover:bg-surface-2"
        >
          <Download className="size-4" /> Descargar copia
        </a>
      </Card>
      <Card title="Importar" icon={<Upload />}>
        <p className="mb-4 text-[13px] text-muted">
          Carga un .jsonl exportado desde aquí. Los documentos con el mismo <span className="font-mono">_id</span> se sobrescriben; el resto se mantiene. Si una línea falla, no se importa nada.
        </p>
        <Button icon={<Upload className="size-4" />} loading={importing !== null} onClick={() => file.current?.click()}>
          {importing !== null ? `Importando ${Math.round(importing * 100)} %` : 'Elegir archivo .jsonl'}
        </Button>
        <input
          ref={file}
          type="file"
          accept=".jsonl,.ndjson,application/x-ndjson,application/json,text/plain"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setImporting(0);
            try {
              const r = await upload<{ documents: number }>(`/api/nosql/${db.id}/import`, f, setImporting, 'POST');
              toast.success(`${r.documents} documentos importados`);
              qc.invalidateQueries({ queryKey: ['nosql-collections', db.id] });
              qc.invalidateQueries({ queryKey: ['nosql-docs', db.id] });
            } catch (err) {
              toast.error((err as Error).message);
            } finally {
              setImporting(null);
            }
          }}
        />
      </Card>
    </div>
  );
}

// --- detail ----------------------------------------------------------------------------------

export function NosqlDetail() {
  const { id } = useParams();
  const dbId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'docs' | 'console' | 'indexes' | 'api' | 'backup'>('docs');
  const q = useQuery({ queryKey: ['nosql-db', dbId], queryFn: () => api.get<NosqlDatabase>(`/api/nosql/${dbId}`) });
  const colls = useQuery({ queryKey: ['nosql-collections', dbId], queryFn: () => api.get<NosqlCollection[]>(`/api/nosql/${dbId}/collections`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const db = q.data!;
  const collections = colls.data ?? [];
  const docs = collections.reduce((a, c) => a + c.count, 0);
  return (
    <>
      <PageHeader
        title={<span className="font-mono">{db.name}</span>}
        description={db.note || 'Base de datos NoSQL de documentos JSON'}
        actions={
          <ConfirmButton
            variant="danger"
            icon={<Trash2 className="size-4" />}
            title={`Eliminar ${db.name}`}
            message="Se borrarán todas sus colecciones, documentos y tokens. No se puede deshacer."
            onConfirm={async () => {
              await api.del(`/api/nosql/${db.id}`);
              qc.invalidateQueries({ queryKey: ['nosql'] });
              navigate('/nosql');
            }}
          >
            Eliminar
          </ConfirmButton>
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Colecciones" value={compact(collections.length)} icon={<Layers />} />
        <StatCard label="Documentos" value={compact(docs)} icon={<FileJson />} />
        <StatCard label="Tamaño" value={bytes(db.size)} icon={<Boxes />} />
        <StatCard
          label="Workers"
          value={db.workers.length}
          sub={db.workers.map((w) => w.name).join(', ') || 'ninguno'}
          icon={<Play />}
        />
      </div>
      {db.workers.length > 0 && (
        <Callout className="mb-5" title="En uso por Workers">
          {db.workers.map((w, i) => (
            <span key={w.id}>
              {i > 0 && ', '}
              <Link className="font-medium text-accent hover:underline" to={`/workers/${w.id}`}>
                {w.name}
              </Link>
            </span>
          ))}
        </Callout>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'docs', label: 'Documentos' },
          { id: 'console', label: 'Consola' },
          { id: 'indexes', label: 'Índices' },
          { id: 'api', label: 'API y tokens' },
          { id: 'backup', label: 'Exportar e importar' },
        ]}
      />
      {colls.isLoading ? (
        <Spinner />
      ) : colls.error ? (
        <ErrorBox error={colls.error} />
      ) : (
        <>
          {tab === 'docs' && <Documents db={db} collections={collections} />}
          {tab === 'console' && <Console db={db} collections={collections} />}
          {tab === 'indexes' && <Indexes db={db} collections={collections} />}
        </>
      )}
      {tab === 'api' && <ApiTab db={db} />}
      {tab === 'backup' && <Backup db={db} />}
    </>
  );
}
